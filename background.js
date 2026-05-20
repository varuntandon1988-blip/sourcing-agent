// Background service worker. Drives the search queue:
// - picks the next queued job
// - opens portal tab, content script extracts candidates and posts back via runtime messages
// - throttles to human pace, pauses on captcha
import { getAll, setAll, update, append, uid } from "./lib/storage.js";
import { scoreCandidate, refineBoolean, refineBooleanNaukri, generateSourcingStrategy } from "./lib/agents.js";
import { SEED_COMPANY_LISTS } from "./lib/seed.js";
import { IT_SERVICES_EXCLUDE, IT_SERVICES_EXCLUDE_TOP } from "./lib/it-services.js";

// Helpers: collect the recruiter-supplied + IT-services hard excludes for a role.
function getHardExcludes(role) {
  const excludeKeywords = Array.isArray(role.excludeKeywords) ? role.excludeKeywords.filter(Boolean) : [];
  const userCos = Array.isArray(role.excludeCompanies) ? role.excludeCompanies.filter(Boolean) : [];
  const includeIT = role.includeITServices === true;
  const itList = includeIT ? [] : IT_SERVICES_EXCLUDE;
  // Dedupe (case-insensitive) preserving order, user list first.
  const seen = new Set();
  const excludeCompaniesHard = [];
  for (const c of [...userCos, ...itList]) {
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    excludeCompaniesHard.push(c);
  }
  const mustHaveKeywords = Array.isArray(role.mustHave) ? role.mustHave.filter(Boolean) : [];
  const idealResumeExcerpts = Array.isArray(role.idealResumes)
    ? role.idealResumes.map((r) => `--- ${r?.name || "resume"} ---\n${r?.text || ""}`).join("\n\n")
    : "";
  return { excludeKeywords, excludeCompaniesHard, mustHaveKeywords, idealResumeExcerpts, includeIT };
}

// Splice missing hard-exclude terms / companies into a boolean's NOT clause.
// If no NOT clause exists, append one. Quotes companies; keywords as given.
function injectHardExcludes(boolean, { excludeKeywords = [], excludeCompaniesHard = [] }) {
  if (!boolean) return boolean;
  const q = (s) => `"${String(s).replace(/"/g, "")}"`;
  const need = [];
  const lower = boolean.toLowerCase();
  for (const kw of excludeKeywords) {
    if (kw && !lower.includes(kw.toLowerCase())) need.push(q(kw));
  }
  for (const co of excludeCompaniesHard) {
    if (co && !lower.includes(co.toLowerCase())) need.push(q(co));
  }
  if (!need.length) return boolean;
  // Find existing NOT (...) and inject before its closing paren.
  const m = boolean.match(/\bNOT\s*\(([^()]*)\)\s*$/i);
  if (m) {
    return boolean.slice(0, m.index) + `NOT (${m[1].trim()} OR ${need.join(" OR ")})`;
  }
  // Try any NOT (...) anywhere
  const m2 = boolean.match(/\bNOT\s*\(([^()]*)\)/i);
  if (m2) {
    const start = m2.index;
    const end = start + m2[0].length;
    return boolean.slice(0, start) + `NOT (${m2[1].trim()} OR ${need.join(" OR ")})` + boolean.slice(end);
  }
  return `${boolean.trim()} NOT (${need.join(" OR ")})`;
}

// Validate that a string looks like a real boolean (not bullets/prose).
// Requires AND or OR, at least one parenthesized group, and no leading list markers.
function looksLikeBoolean(s) {
  if (!s || typeof s !== "string") return false;
  const t = s.trim();
  if (!/[()]/.test(t)) return false;
  if (!/\b(AND|OR)\b/.test(t)) return false;
  // Reject bullet/numbered list output
  if (/^\s*[-*•]\s/m.test(t)) return false;
  if (/^\s*\d+[.)]\s/m.test(t)) return false;
  // Reject obvious labels
  if (/^(must[- ]haves?|keywords?|boolean)\s*:/im.test(t)) return false;
  return true;
}

// Seed once
chrome.runtime.onInstalled.addListener(async () => {
  const lists = await getAll("companyLists", []);
  if (!lists.length) {
    await setAll(
      "companyLists",
      SEED_COMPANY_LISTS.map((l) => ({ id: uid(), ...l }))
    );
  }
});

const PORTAL_URLS = {
  linkedin: (q) =>
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}&origin=GLOBAL_SEARCH_HEADER`,
  naukri: (q) =>
    `https://www.naukri.com/${encodeURIComponent(q.replace(/\s+/g, "-").toLowerCase())}-jobs`,
  instahyre: (q) =>
    `https://www.instahyre.com/search/?keywords=${encodeURIComponent(q)}`,
};

let workerTab = null;
let working = false;

async function processNext() {
  if (working) return;
  const queue = await getAll("queue", []);
  const job = queue.find((j) => j.status === "queued");
  if (!job) return;
  working = true;
  await update("queue", job.id, { status: "running" });
  const search = await append("searches", {
    id: uid(),
    roleId: job.roleId,
    portal: job.portal,
    status: "running",
    query: job.query,
    startedAt: Date.now(),
    count: 0,
  });

  try {
    const url = PORTAL_URLS[job.portal](job.query);
    const tab = await chrome.tabs.create({ url, active: false });
    workerTab = tab.id;

    // Wait for content script to send results
    const candidates = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out (90s)")), 90000);
      const listener = (msg, sender) => {
        if (sender.tab?.id !== tab.id) return;
        if (msg.type === "candidates") {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          resolve(msg.payload);
        } else if (msg.type === "captcha") {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          reject(new Error("Captcha or login required"));
        }
      };
      chrome.runtime.onMessage.addListener(listener);
    });

    // Persist + score
    const roles = await getAll("roles", []);
    const role = roles.find((r) => r.id === job.roleId);
    let saved = 0;
    for (const c of candidates) {
      const cand = {
        id: uid(),
        searchId: search.id,
        roleId: job.roleId,
        portal: job.portal,
        ...c,
        createdAt: Date.now(),
      };
      try {
        const _co = await resolveTargetCompanies(role);
        const s = await scoreCandidate({ role, candidate: cand, workMode: role.workMode, targetCompanies: _co, ...getHardExcludes(role) });
        Object.assign(cand, s);
      } catch (e) {
        cand.scoreError = String(e.message || e);
      }
      await append("candidates", cand);
      saved++;
      await new Promise((r) => setTimeout(r, 600)); // gentle pace
    }
    await update("searches", search.id, {
      status: "done",
      finishedAt: Date.now(),
      count: saved,
    });
    await update("queue", job.id, { status: "done" });
    try { await chrome.tabs.remove(tab.id); } catch {}
  } catch (e) {
    await update("searches", search.id, {
      status: "error",
      finishedAt: Date.now(),
      error: String(e.message || e),
    });
    await update("queue", job.id, { status: "error", error: String(e.message || e) });
  } finally {
    working = false;
    workerTab = null;
    setTimeout(processNext, 2000);
  }
}

// Slugify for safe folder names
const slug = (s) => (s || "role").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// Route portal-initiated downloads (resume buttons) into per-role subfolder
let pendingDownload = null; // { roleSlug, candidateName }
chrome.downloads.onDeterminingFilename?.addListener((item, suggest) => {
  if (!pendingDownload) return suggest();
  const { roleSlug, candidateName } = pendingDownload;
  pendingDownload = null;
  const ext = (item.filename.match(/\.[a-z0-9]+$/i)?.[0]) || ".pdf";
  const safeName = slug(candidateName) || "candidate";
  suggest({ filename: `sourcing-agent/${roleSlug}/${safeName}${ext}`, conflictAction: "uniquify" });
});

async function bulkOpen(urls) {
  for (const url of urls) {
    try { await chrome.tabs.create({ url, active: false }); } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
}

const RESUME_SCRIPTS = {
  linkedin: "content/resume-linkedin.js",
  naukri: "content/resume-naukri.js",
  instahyre: "content/resume-instahyre.js",
};

async function downloadResumes(candidateIds) {
  const [cands, roles] = await Promise.all([getAll("candidates", []), getAll("roles", [])]);
  const results = [];
  for (const id of candidateIds) {
    const c = cands.find((x) => x.id === id);
    if (!c || !c.profileUrl) { results.push({ id, ok: false, reason: "No profile URL" }); continue; }
    const role = roles.find((r) => r.id === c.roleId);
    const roleSlug = slug(role?.title);
    const script = RESUME_SCRIPTS[c.portal];
    if (!script) { results.push({ id, ok: false, reason: "Unsupported portal" }); continue; }
    try {
      const tab = await chrome.tabs.create({ url: c.profileUrl, active: false });
      // wait for load
      await new Promise((res) => {
        const fn = (tabId, info) => {
          if (tabId === tab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(fn); res();
          }
        };
        chrome.tabs.onUpdated.addListener(fn);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); res(); }, 15000);
      });
      pendingDownload = { roleSlug, candidateName: c.name };
      const [out] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [script],
      });
      // Give the download time to start before clearing pending
      await new Promise((r) => setTimeout(r, 3000));
      pendingDownload = null;
      await update("candidates", id, { resumeAttemptedAt: Date.now(), resumeOk: out?.result?.ok !== false });
      results.push({ id, ok: out?.result?.ok !== false, reason: out?.result?.reason });
      try { await chrome.tabs.remove(tab.id); } catch {}
      await new Promise((r) => setTimeout(r, 1500)); // throttle
    } catch (e) {
      pendingDownload = null;
      results.push({ id, ok: false, reason: String(e.message || e) });
    }
  }
  return results;
}

// Detect portal from a tab URL
function detectPortal(url = "") {
  if (/linkedin\.com/i.test(url)) return "linkedin";
  if (/naukri\.com/i.test(url)) return "naukri";
  if (/instahyre\.com/i.test(url)) return "instahyre";
  return null;
}

const CAPTURE_SCRIPTS = {
  linkedin: "content/linkedin-recruiter.js",
  naukri: "content/naukri-resdex.js",
  instahyre: "content/instahyre-recruiter.js",
};

async function captureActiveTab(roleId) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  const portal = detectPortal(tab.url);
  if (!portal) throw new Error("Active tab is not LinkedIn, Naukri, or Instahyre");
  const file = CAPTURE_SCRIPTS[portal];

  // All three scrapers return the array via the IIFE return value
  const [out] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
  let candidates = out?.result;
  if (candidates && typeof candidates.then === "function") candidates = await candidates;
  if (!Array.isArray(candidates)) candidates = [];


  const search = await append("searches", {
    id: uid(), roleId, portal, status: "running",
    query: `(captured from tab) ${tab.url}`, startedAt: Date.now(), count: 0,
  });
  const roles = await getAll("roles", []);
  const role = roles.find((r) => r.id === roleId);
  let saved = 0;
  for (const c of candidates) {
    const cand = { id: uid(), searchId: search.id, roleId, portal, ...c, createdAt: Date.now() };
    try {
      const _co = await resolveTargetCompanies(role);
      const s = await scoreCandidate({ role, candidate: cand, workMode: role.workMode, targetCompanies: _co, ...getHardExcludes(role) });
      Object.assign(cand, s);
    } catch (e) { cand.scoreError = String(e.message || e); }
    await append("candidates", cand);
    saved++;
  }
  await update("searches", search.id, { status: "done", finishedAt: Date.now(), count: saved });
  return { ok: true, saved, portal };
}

// ===== Comet-style LinkedIn agent =====
// Takes over the *currently active* LinkedIn tab, applies filters from the role,
// paginates through results, opens each profile in the same tab to deep-scrape,
// scores via AI, and saves to candidates with the profile URL.

const agentState = { running: false, status: "", processed: 0, total: 0, log: [] };

function logAgent(msg) {
  agentState.log.push({ t: Date.now(), msg });
  if (agentState.log.length > 200) agentState.log.shift();
  agentState.status = msg;
  chrome.runtime.sendMessage({ type: "agentProgress", state: { ...agentState } }).catch(() => {});
}

async function waitForTabLoad(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const fn = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(fn);
        setTimeout(resolve, 1200); // small settle
      }
    };
    chrome.tabs.onUpdated.addListener(fn);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); resolve(); }, timeoutMs);
  });
}

// Resolve the role's target-company pool: union of selected category companies + customCompanies.
async function resolveTargetCompanies(role) {
  const lists = await getAll("companyLists", []);
  const fromCats = lists
    .filter((l) => (role.categories || []).includes(l.name))
    .flatMap((l) => l.companies || []);
  const custom = role.customCompanies || [];
  return Array.from(new Set([...fromCats, ...custom].filter(Boolean)));
}

// Resolve categorized company breakdown for the AI: per-category names + companies.
async function resolveCategorizedCompanies(role) {
  const lists = await getAll("companyLists", []);
  const selected = (role.categories || []);
  const cats = lists
    .filter((l) => selected.includes(l.name))
    .map((l) => ({ name: l.name, companies: (l.companies || []).filter(Boolean) }));
  return {
    categoryNames: cats.map((c) => c.name),
    categories: cats,
    customCompanies: (role.customCompanies || []).filter(Boolean),
  };
}

// Local fallback: build a Principal-Recruiter style boolean using role data + target companies.
function buildLinkedInKeywordsLocal(role, companies = []) {
  const q = (s) => `"${String(s).replace(/"/g, "")}"`;
  const title = role.title || "";
  const seniority = (role.parsed?.seniority || "").toLowerCase();

  // Title synonyms across the right seniority band.
  const baseTitle = title.replace(/^(senior|sr|staff|principal|lead|junior|jr)\s+/i, "").trim();
  const seniorityPrefixes = /(staff|principal)/.test(seniority)
    ? ["Staff", "Principal", "Senior Staff", "Lead"]
    : /senior|sr/.test(seniority)
      ? ["Senior", "Sr", "Lead", "Staff"]
      : ["Senior", "Lead", baseTitle ? "" : "Software"];
  const titles = new Set();
  if (title) titles.add(title);
  if (baseTitle) {
    for (const p of seniorityPrefixes) {
      const t = `${p} ${baseTitle}`.trim();
      if (t) titles.add(t);
    }
    titles.add(baseTitle);
  }

  // Skills — pick top 4-6 most defining; group multi-word as quoted phrases.
  const skills = (role.skills || []).filter(Boolean).slice(0, 6);

  // Excluded titles based on IC vs. manager hint in the title.
  const isManager = /manager|director|head|vp/i.test(title);
  const excludeTitles = isManager
    ? ["intern", "fresher", "student", "sales", "marketing", "support"]
    : ["intern", "fresher", "student", "manager", "director", "sales", "marketing", "support", "recruiter", "teacher"];

  const orPart = (arr, max) => arr.slice(0, max).map(q).join(" OR ");
  const parts = [];
  if (titles.size) parts.push(`(${orPart(Array.from(titles), 5)})`);
  if (skills.length) parts.push(`(${orPart(skills, 6)})`);
  if (companies && companies.length) parts.push(`(${orPart(companies, 15)})`);
  parts.push(`NOT (${excludeTitles.map(q).join(" OR ")})`);
  return parts.join(" AND ").trim();
}

async function buildLinkedInBoolean(role) {
  const companies = await resolveTargetCompanies(role);
  const hard = getHardExcludes(role);
  if (hard.excludeCompaniesHard.length) {
    logAgent(`Hard excludes (companies, ${hard.includeIT ? "user-only" : "incl. IT services"}): ${hard.excludeCompaniesHard.slice(0, 12).join(", ")}${hard.excludeCompaniesHard.length > 12 ? "…" : ""}`);
  }
  if (hard.excludeKeywords.length) logAgent(`Hard excludes (keywords): ${hard.excludeKeywords.join(", ")}`);
  if (hard.mustHaveKeywords.length) logAgent(`Hard must-haves: ${hard.mustHaveKeywords.join(", ")}`);
  try {
    const r = await refineBoolean({
      role,
      companies,
      mustHaveKeywords: hard.mustHaveKeywords,
      excludeKeywords: hard.excludeKeywords,
      excludeCompaniesHard: hard.excludeCompaniesHard,
      idealResumeExcerpts: hard.idealResumeExcerpts,
    });
    if (r && typeof r === "object") {
      try {
        if (Array.isArray(r.titlesInclude) && r.titlesInclude.length) logAgent(`Titles include: ${r.titlesInclude.slice(0, 8).join(", ")}`);
        if (Array.isArray(r.titlesExclude) && r.titlesExclude.length) logAgent(`Titles exclude: ${r.titlesExclude.slice(0, 8).join(", ")}`);
        if (Array.isArray(r.skillsInclude) && r.skillsInclude.length) logAgent(`Skills include: ${r.skillsInclude.slice(0, 10).join(", ")}`);
        if (Array.isArray(r.skillsExclude) && r.skillsExclude.length) logAgent(`Skills exclude: ${r.skillsExclude.slice(0, 8).join(", ")}`);
        if (Array.isArray(r.companiesPriority) && r.companiesPriority.length) logAgent(`Target companies: ${r.companiesPriority.slice(0, 12).join(", ")}`);
        if (r.location) logAgent(`Location target: ${r.location}`);
        if (r.rationale) logAgent(`Strategy: ${r.rationale}`);
      } catch {}
      if (r.boolean && typeof r.boolean === "string") {
        let b = r.boolean.trim();
        if (companies.length && !/\bAND\s*\(/i.test(b.split(/NOT/i)[0]?.split(/\)/g).slice(2).join(")") || "")) {
          const anyMatch = companies.slice(0, 30).some((c) => b.toLowerCase().includes(c.toLowerCase()));
          if (!anyMatch) {
            const co = companies.slice(0, 15).map((c) => `"${c}"`).join(" OR ");
            const notIdx = b.search(/\bNOT\b/i);
            b = notIdx > 0 ? `${b.slice(0, notIdx).trim()} AND (${co}) ${b.slice(notIdx)}` : `${b} AND (${co})`;
            logAgent("Injected target-company clause (was missing from AI output).");
          }
        }
        // Safety net: ensure all hard excludes are in NOT clause.
        const before = b;
        b = injectHardExcludes(b, hard);
        if (b !== before) logAgent("Injected missing hard-exclude terms into NOT clause.");
        return b;
      }
    }
  } catch (e) {
    logAgent(`refineBoolean failed, using local fallback: ${e?.message || e}`);
  }
  let local = buildLinkedInKeywordsLocal(role, companies);
  local = injectHardExcludes(local, hard);
  return local;
}

// Naukri Resdex boolean — purpose-built for the keyword field (resume-text search,
// 500-char hard limit, separate fields for title/location/exp/active-in).
async function buildNaukriBoolean(role) {
  const hard = getHardExcludes(role);
  const MAX = 500;
  if (hard.excludeCompaniesHard.length) {
    logAgent(`Naukri hard excludes (companies, ${hard.includeIT ? "user-only" : "incl. IT services"}): ${hard.excludeCompaniesHard.slice(0, 12).join(", ")}${hard.excludeCompaniesHard.length > 12 ? "…" : ""}`);
  }
  if (hard.excludeKeywords.length) logAgent(`Naukri hard excludes (keywords): ${hard.excludeKeywords.join(", ")}`);
  if (hard.mustHaveKeywords.length) logAgent(`Naukri hard must-haves: ${hard.mustHaveKeywords.join(", ")}`);

  const q = (s) => `"${String(s).replace(/"/g, "")}"`;

  // Try AI first.
  let aiBool = "";
  try {
    const r = await refineBooleanNaukri({
      role,
      mustHaveKeywords: hard.mustHaveKeywords,
      excludeKeywords: hard.excludeKeywords,
      excludeCompaniesHard: hard.excludeCompaniesHard,
      idealResumeExcerpts: hard.idealResumeExcerpts,
    });
    if (r?.boolean && typeof r.boolean === "string") {
      const candidate = r.boolean.trim().replace(/\s*\n+\s*/g, " ");
      if (looksLikeBoolean(candidate)) {
        aiBool = candidate;
        if (Array.isArray(r.mustHaveCoverage) && r.mustHaveCoverage.length) logAgent(`Naukri must-have coverage: ${r.mustHaveCoverage.join(", ")}`);
        if (Array.isArray(r.differentiators) && r.differentiators.length) logAgent(`Naukri differentiators: ${r.differentiators.join(", ")}`);
        if (Array.isArray(r.droppedForBudget) && r.droppedForBudget.length) logAgent(`Naukri dropped for 500-char budget: ${r.droppedForBudget.join(", ")}`);
        if (r.rationale) logAgent(`Naukri strategy: ${r.rationale}`);
      } else {
        logAgent("AI returned non-boolean format (bullets/prose) — discarding and using local builder.");
      }
    }
  } catch (e) {
    logAgent(`refineBooleanNaukri failed, using local fallback: ${e?.message || e}`);
  }

  // Local fallback / safety net: build a clean boolean string from role data.
  let boolean = aiBool || "";
  if (!boolean) {
    const musts = (hard.mustHaveKeywords.length ? hard.mustHaveKeywords : (role.skills || []).slice(0, 3)).filter(Boolean);
    const mustGroups = musts.slice(0, 4).map((m) => `(${q(m)})`);
    // One differentiator group from remaining JD skills (skip ones already in must-haves).
    const usedLower = new Set(musts.map((m) => m.toLowerCase()));
    const diffs = (role.skills || []).filter((s) => s && !usedLower.has(s.toLowerCase())).slice(0, 4);
    const diffGroup = diffs.length ? ` AND (${diffs.map(q).join(" OR ")})` : "";
    const noise = ["intern", "fresher", "trainee"];
    const notTerms = [...noise, ...hard.excludeKeywords].map(q).concat(hard.excludeCompaniesHard.map(q));
    const head = mustGroups.length ? mustGroups.join(" AND ") : `(${q(role.title || "engineer")})`;
    boolean = `${head}${diffGroup}${notTerms.length ? ` NOT (${notTerms.join(" OR ")})` : ""}`.trim();
  }

  // Inject any missing hard-excludes (safety net).
  boolean = injectHardExcludes(boolean, hard);

  // Enforce 500-char limit by trimming the NOT-clause companies (keep keywords + noise).
  if (boolean.length > MAX) {
    const orig = boolean.length;
    // Drop companies from the NOT clause one-by-one (lowest priority first = end of IT_SERVICES_EXCLUDE).
    if (!hard.includeIT) {
      const itLower = IT_SERVICES_EXCLUDE.map((c) => c.toLowerCase());
      // Drop from tail of IT services first.
      const dropOrder = [...IT_SERVICES_EXCLUDE].reverse().filter((c) => !IT_SERVICES_EXCLUDE_TOP.includes(c));
      for (const c of dropOrder) {
        const rx = new RegExp(`\\s*OR\\s*"${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i");
        boolean = boolean.replace(rx, "");
        if (boolean.length <= MAX) break;
      }
    }
    // If still over, drop top-IT companies one at a time (least famous first).
    if (boolean.length > MAX && !hard.includeIT) {
      for (const c of [...IT_SERVICES_EXCLUDE_TOP].reverse()) {
        const rx = new RegExp(`\\s*OR\\s*"${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i");
        boolean = boolean.replace(rx, "");
        if (boolean.length <= MAX) break;
      }
    }
    // Last resort: drop the optional differentiator group (the LAST AND-group that isn't NOT and isn't a must-have).
    if (boolean.length > MAX) {
      const mustLower = hard.mustHaveKeywords.map((m) => m.toLowerCase());
      const notIdx = boolean.search(/\bNOT\s*\(/i);
      const head = notIdx > 0 ? boolean.slice(0, notIdx).trim() : boolean;
      const tail = notIdx > 0 ? boolean.slice(notIdx) : "";
      const groups = head.split(/\s+AND\s+/i);
      // Walk groups from end; drop first one that doesn't contain a must-have.
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i].toLowerCase();
        if (mustLower.some((m) => m && g.includes(m))) continue;
        groups.splice(i, 1);
        boolean = (groups.join(" AND ") + " " + tail).trim();
        if (boolean.length <= MAX) break;
      }
    }
    // Balance parens.
    const o = (boolean.match(/\(/g) || []).length;
    const c = (boolean.match(/\)/g) || []).length;
    if (c < o) boolean += ")".repeat(o - c);
    logAgent(`Naukri boolean trimmed ${orig} → ${boolean.length} chars (500-char limit).`);
  }

  return boolean;
}
// Requires an active linkedin.com session in this browser. Result is cached.
async function resolveGeoUrn(tabId, location) {
  if (!location) return null;
  const cache = await getAll("geoCache", []);
  const cached = cache.find((c) => c.location?.toLowerCase() === location.toLowerCase());
  if (cached) return cached.geoUrn;
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (loc) => {
        try {
          const url = `https://www.linkedin.com/voyager/api/typeahead/hits?keywords=${encodeURIComponent(loc)}&origin=OTHER&q=type&type=GEO`;
          const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1];
          const r = await fetch(url, {
            credentials: "include",
            headers: { "csrf-token": csrf || "", accept: "application/vnd.linkedin.normalized+json+2.1" },
          });
          if (!r.ok) return null;
          const data = await r.json();
          const hit = (data.elements || data.included || [])[0];
          const id = hit?.objectUrn?.match?.(/\d+$/)?.[0] || hit?.id || null;
          return id;
        } catch { return null; }
      },
      args: [location],
    });
    const id = out?.result;
    if (id) await append("geoCache", { id: uid(), location, geoUrn: id, createdAt: Date.now() });
    return id || null;
  } catch { return null; }
}

// If on LinkedIn Recruiter (talent/home or recruiter), click the search CTA, paste boolean, submit.
async function pasteBooleanIntoRecruiter(tabId, keywords) {
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (kw) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const log = (m) => console.log("[sourcing-agent]", m);

        const isVisible = (el) => {
          const r = el?.getBoundingClientRect?.();
          const s = el ? getComputedStyle(el) : null;
          return !!(r && r.width > 8 && r.height > 8 && s?.visibility !== "hidden" && s?.display !== "none");
        };

        function findInput() {
          const all = Array.from(document.querySelectorAll(
            'textarea, input[type="text"], input[type="search"], [contenteditable="true"], [role="textbox"], [role="combobox"], .ql-editor'
          ));
          const score = (el) => {
            const ph = (el.getAttribute?.("placeholder") || "").toLowerCase();
            const aph = (el.getAttribute?.("aria-placeholder") || "").toLowerCase();
            const al = (el.getAttribute?.("aria-label") || "").toLowerCase();
            const txt = (el.innerText || el.textContent || "").toLowerCase();
            const parentTxt = (el.closest?.('form, [role="search"], section, div')?.innerText || "").toLowerCase().slice(0, 500);
            const t = ph + " " + aph + " " + al + " " + txt + " " + parentTxt;
            if (t.includes("typing anything") || t.includes("get started by typing")) return 100;
            if (t.includes("search") || t.includes("ai search")) return 50;
            if (el.tagName === "TEXTAREA") return 20;
            return 1;
          };
          let best = null, bestScore = 0;
          for (const el of all) {
            if (!isVisible(el)) continue;
            const s = score(el);
            if (s > bestScore) { best = el; bestScore = s; }
          }
          return best;
        }

        let input = null;
        for (let i = 0; i < 40; i++) {
          input = findInput();
          if (input) break;
          await sleep(400);
        }
        if (!input) { log("no input found"); return { ok: false, reason: "no-search-input" }; }

        // Real-user-like focus sequence so Recruiter enables the submit button.
        try { input.scrollIntoView({ block: "center" }); } catch {}
        const ir0 = input.getBoundingClientRect();
        const cx0 = ir0.left + ir0.width / 2, cy0 = ir0.top + ir0.height / 2;
        for (const type of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          input.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx0, clientY: cy0, button: 0 }));
        }
        input.focus();
        await sleep(250);

        async function doPaste() {
          if (input.tagName === "INPUT" || input.tagName === "TEXTAREA") {
            const proto = input.tagName === "INPUT" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            setter?.call(input, kw);
            input.value = kw;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
          // contenteditable
          try {
            const range = document.createRange();
            range.selectNodeContents(input);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          } catch {}
          try {
            const dt = new DataTransfer();
            dt.setData("text/plain", kw);
            input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
          } catch {}
          try { document.execCommand("insertText", false, kw); } catch {}
          if (!input.innerText || !input.innerText.trim()) {
            input.textContent = kw;
          }
          input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertFromPaste", data: kw }));
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: kw }));
          // Synthetic key event for the trailing char so React/Recruiter flips submit-enabled.
          const lastCh = kw.slice(-1) || " ";
          for (const type of ["keydown", "keypress", "keyup"]) {
            input.dispatchEvent(new KeyboardEvent(type, { key: lastCh, bubbles: true, composed: true }));
          }
        }

        await doPaste();

        // Verify the boolean is actually in the input; retry once if not.
        const head = kw.slice(0, 24);
        let ok = false;
        for (let i = 0; i < 10; i++) {
          const cur = (input.value ?? input.innerText ?? "").toString();
          if (cur.includes(head)) { ok = true; break; }
          await sleep(200);
        }
        if (!ok) {
          log("paste verify failed — retrying");
          input.focus();
          await sleep(150);
          await doPaste();
          await sleep(800);
        }
        await sleep(700);

        // Find the actual blue paper-plane submit button.
        function findSubmit() {
          const ir = input.getBoundingClientRect();
          // Walk up to find a container that holds the input + the icon button row.
          let scope = input.closest('form, [role="search"]') || input.parentElement;
          let pool = [];
          for (let depth = 0; depth < 8 && scope; depth++) {
            pool = Array.from(scope.querySelectorAll('button, [role="button"]'))
              .filter((el) => el !== input && isVisible(el))
              .filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true")
              .filter((el) => el.querySelector?.("svg, img"));
            if (pool.length) break;
            scope = scope.parentElement;
          }
          if (!pool.length) return null;

          const NEG = /expand|collapse|sidebar|history|filter|attach|menu|close|add|plus|new|more|clear|delete|microphone|mic|voice|emoji|upload/i;
          const POS = /submit|send|search/i;

          const scored = pool.map((el) => {
            const r = el.getBoundingClientRect();
            const label = (el.getAttribute("aria-label") || el.title || el.innerText || "").trim();
            let s = 0;
            if (POS.test(label)) s += 100;
            if (NEG.test(label)) s -= 200;
            // Same row as input (right side)
            if (r.top >= ir.top - 12 && r.bottom <= ir.bottom + 12) s += 30;
            if (r.left >= ir.right - 200 && r.right <= ir.right + 80) s += 30;
            // Paper-plane SVG heuristic
            const svg = el.querySelector("svg");
            const paths = svg ? Array.from(svg.querySelectorAll("path")).map((p) => p.getAttribute("d") || "").join(" ") : "";
            if (/M2[\s,.\-0-9]/.test(paths) || /l1[01]|l9/.test(paths) || /send/i.test(svg?.outerHTML || "")) s += 50;
            // type=submit bonus
            if (el.getAttribute("type") === "submit") s += 40;
            return { el, r, s, label };
          });
          scored.sort((a, b) => b.s - a.s || b.r.right - a.r.right);
          return scored[0]?.s > -100 ? scored[0].el : null;
        }

        // Poll for the submit button to become enabled.
        let btn = null;
        for (let i = 0; i < 30; i++) {
          btn = findSubmit();
          if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") break;
          await sleep(300);
        }

        const urlBefore = location.href;
        if (btn) {
          try { btn.scrollIntoView({ block: "center" }); } catch {}
          const r = btn.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          for (const type of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 }));
          }
          try { btn.click(); } catch {}
          log("submit clicked: " + (btn.getAttribute("aria-label") || btn.className || btn.tagName));
        }

        // If URL hasn't changed after 4s, fall back to Enter on the input.
        await sleep(4000);
        if (location.href === urlBefore) {
          log("submit didn't navigate — falling back to Enter");
          input.focus();
          for (const type of ["keydown", "keypress", "keyup"]) {
            input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, composed: true }));
          }
        }
        return { ok: true };
      },
      args: [keywords],
    });
    return !!out?.result?.ok;
  } catch { return false; }
}

function buildLinkedInPeopleUrl({ keywords, geoUrn, page = 1, distance = 50 }) {
  const params = new URLSearchParams();
  if (keywords) params.set("keywords", keywords);
  if (geoUrn) {
    params.set("geoUrn", `["${geoUrn}"]`);
    params.set("distance", String(distance));
  }
  params.set("origin", "FACETED_SEARCH");
  if (page > 1) params.set("page", String(page));
  return `https://www.linkedin.com/search/results/people/?${params.toString()}`;
}

async function runLinkedInAgent({ roleId, targetShortlist = 10, hardCapPages = 10, deep = true }) {
  if (agentState.running) throw new Error("Agent already running");
  const roles = await getAll("roles", []);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw new Error("Role not found");

  // If the recruiter is already on a results page (talent/recruiter search or people search),
  // skip the paste step and start scraping from where they are.
  const RESULTS_RX = /linkedin\.com\/(talent\/search|recruiter\/smartsearch|recruiter\/search|search\/results\/people)/i;
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let alreadyOnResults = !!(tab?.id && RESULTS_RX.test(tab.url || ""));

  if (!tab?.id || !/linkedin\.com/i.test(tab.url || "")) {
    // Prefer an existing results tab if one is open in any window.
    const resultsTab = (await chrome.tabs.query({ url: ["*://*.linkedin.com/talent/*", "*://*.linkedin.com/recruiter/*", "*://*.linkedin.com/search/results/people/*"] }))[0];
    if (resultsTab?.id) {
      tab = resultsTab;
      alreadyOnResults = RESULTS_RX.test(tab.url || "");
      await chrome.tabs.update(tab.id, { active: true });
    } else {
      const existing = (await chrome.tabs.query({ url: "*://*.linkedin.com/*" }))[0];
      if (existing?.id) {
        tab = existing;
        alreadyOnResults = RESULTS_RX.test(tab.url || "");
        await chrome.tabs.update(tab.id, { active: true });
      } else {
        tab = await chrome.tabs.create({ url: "https://www.linkedin.com/talent/home", active: true });
        await waitForTabLoad(tab.id, 30000);
      }
    }
  }
  // Only force-navigate to talent/home when we are NOT already on a results page.
  if (!alreadyOnResults && !/linkedin\.com\/talent\/home/i.test(tab.url || "")) {
    logAgent("Opening https://www.linkedin.com/talent/home …");
    await chrome.tabs.update(tab.id, { url: "https://www.linkedin.com/talent/home" });
    await waitForTabLoad(tab.id, 30000);
  }
  if (alreadyOnResults) {
    logAgent("Detected existing search results page — skipping boolean paste, scraping from here.");
  }

  agentState.running = true;
  agentState.processed = 0;
  agentState.total = 0;
  agentState.log = [];
  agentState.roleId = roleId;
  logAgent(`Starting LinkedIn agent for role: ${role.title}`);

  const search = await append("searches", {
    id: uid(), roleId, portal: "linkedin", status: "running",
    query: `(agent) ${role.title}`, startedAt: Date.now(), count: 0,
  });

  let shortlistCount = 0;
  let saved = 0;

  try {
    logAgent("Crafting boolean (principal-recruiter mode)…");
    const agentCompanies = await resolveTargetCompanies(role);
    const keywords = await buildLinkedInBoolean(role);
    logAgent("Boolean: " + (keywords || "(empty)"));
    if (!keywords) throw new Error("Empty boolean — fill in title/skills first.");

    const seen = new Set();
    for (let page = 1; page <= hardCapPages; page++) {
      if (shortlistCount >= targetShortlist) {
        logAgent(`Hit target of ${targetShortlist} shortlists. Stopping.`);
        break;
      }
      if (page === 1) {
        if (alreadyOnResults) {
          logAgent("Page 1: using existing results page (no paste).");
        } else {
          // Recruiter-driven flow: do NOT auto-paste. Wait for the recruiter to paste
          // the boolean and submit the search themselves.
          logAgent("➡  Copy the boolean above, paste it into the LinkedIn Recruiter search bar, and run the search. The agent will start scraping automatically once results load.");
          const RESULTS_RX2 = /linkedin\.com\/(talent\/search|recruiter\/smartsearch|recruiter\/search|search\/results\/people)/i;
          const WAIT_MS = 5 * 60 * 1000;
          const startWait = Date.now();
          let ready = false;
          while (Date.now() - startWait < WAIT_MS) {
            const t = await chrome.tabs.get(tab.id).catch(() => null);
            if (t && RESULTS_RX2.test(t.url || "")) { ready = true; break; }
            await new Promise((r) => setTimeout(r, 2500));
          }
          if (!ready) {
            logAgent("Timed out waiting for LinkedIn results page. Run the agent again after submitting the search.");
            break;
          }
          await waitForTabLoad(tab.id, 30000);
        }
      } else {
        logAgent(`Page ${page}: clicking Next…`);
        const [clk] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const b = document.querySelector('button[aria-label="Next"]:not([disabled]), button.artdeco-pagination__button--next:not([disabled]), a[aria-label="Next"]');
            if (!b) return false;
            b.scrollIntoView(); b.click(); return true;
          },
        });
        if (!clk?.result) { logAgent("No Next button — stopping."); break; }
        await waitForTabLoad(tab.id, 25000);
      }

      const [out] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/linkedin-agent.js"],
      });
      let res = out?.result;
      if (res && typeof res.then === "function") res = await res;
      if (!res || res.error === "captcha") {
        logAgent("Captcha / login wall — pausing. Please solve, then re-run.");
        break;
      }
      const cands = (res.candidates || []).filter((c) => !seen.has(c.profileUrl));
      cands.forEach((c) => seen.add(c.profileUrl));
      logAgent(`Page ${page}: found ${cands.length} new profile(s).`);
      agentState.total += cands.length;

      if (!cands.length && page > 1) { logAgent("Empty page — stopping."); break; }

      for (const c of cands) {
        if (shortlistCount >= targetShortlist) break;
        let enriched = { ...c };
        if (deep && c.profileUrl) {
          try {
            logAgent(`Opening ${c.name}…`);
            await chrome.tabs.update(tab.id, { url: c.profileUrl });
            await waitForTabLoad(tab.id, 18000);
            const [pOut] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ["content/linkedin-profile.js"],
            });
            let p = pOut?.result;
            if (p && typeof p.then === "function") p = await p;
            if (p) {
              enriched = {
                ...enriched,
                name: p.name || enriched.name,
                headline: p.headline || enriched.headline,
                company: p.company || enriched.company,
                location: p.location || enriched.location,
                about: p.about,
                experienceText: p.experienceText,
                skillsList: p.skillsList,
                availability: p.availability || enriched.availability || "active",
                openToWork: typeof p.openToWork === "boolean" ? p.openToWork : !!enriched.openToWork,
                companies: Array.isArray(p.companies) && p.companies.length ? p.companies : (enriched.companies || (enriched.company ? [enriched.company] : [])),
              };
            }
          } catch (e) { logAgent("Profile scrape failed: " + (e.message || e)); }
        }

        const cand = {
          id: uid(), searchId: search.id, roleId, portal: "linkedin",
          ...enriched, createdAt: Date.now(),
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const s = await scoreCandidate({ role, candidate: cand, workMode: role.workMode, targetCompanies: agentCompanies, ...getHardExcludes(role) });
            Object.assign(cand, s);
            cand.scoreError = null;
            break;
          } catch (e) {
            cand.scoreError = String(e.message || e);
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
        const score = cand.score || 0;
        if (score >= 80) { cand.bucket = "auto"; cand.shortlisted = true; shortlistCount++; }
        else if (score >= 70) { cand.bucket = "review"; cand.shortlisted = false; }
        else { cand.bucket = "reject"; cand.shortlisted = false; }

        await append("candidates", cand);
        saved++;
        agentState.processed = saved;
        logAgent(`Saved ${cand.name} — score ${cand.score ?? "?"} (${cand.bucket}). Shortlist ${shortlistCount}/${targetShortlist}.`);
        chrome.runtime.sendMessage({ type: "agentCandidate", candidate: cand }).catch(() => {});
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    await update("searches", search.id, { status: "done", finishedAt: Date.now(), count: saved });
    logAgent(`Done. Saved ${saved}, auto-shortlisted ${shortlistCount}.`);
    return { ok: true, saved, shortlisted: shortlistCount };
  } catch (e) {
    await update("searches", search.id, { status: "error", finishedAt: Date.now(), error: String(e.message || e) });
    logAgent("Error: " + (e.message || e));
    throw e;
  } finally {
    agentState.running = false;
  }
}

// Generic portal agent for Naukri Resdex and Instahyre Recruiter.
// Reuses existing capture scripts + same scoring model.
// Operates on the active tab; paginates via portal-specific "Next".
async function runPortalAgent({ roleId, portal, targetShortlist = 10, hardCapPages = 10, maxProfiles = 0 }) {
  if (agentState.running) throw new Error("Agent already running");
  const roles = await getAll("roles", []);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw new Error("Role not found");

  const portalUrlMatch = portal === "naukri" ? /naukri\.com/i : /instahyre\.com/i;
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !portalUrlMatch.test(tab.url || "")) {
    const existing = (await chrome.tabs.query({ url: portal === "naukri" ? "*://*.naukri.com/*" : "*://*.instahyre.com/*" }))[0];
    if (existing?.id) { tab = existing; await chrome.tabs.update(tab.id, { active: true }); }
    else throw new Error(`Open ${portal === "naukri" ? "Naukri Resdex" : "Instahyre"} in a tab first.`);
  }

  agentState.running = true;
  agentState.processed = 0; agentState.total = 0; agentState.log = []; agentState.roleId = roleId;
  logAgent(`Starting ${portal} agent for role: ${role.title}`);

  const file = CAPTURE_SCRIPTS[portal];
  const search = await append("searches", {
    id: uid(), roleId, portal, status: "running",
    query: `(agent) ${role.title}`, startedAt: Date.now(), count: 0,
  });

  let shortlistCount = 0, saved = 0;
  try {
    const agentCompanies = await resolveTargetCompanies(role);
    const seen = new Set();

    const targetProfiles = Number(maxProfiles) || 0;
    for (let page = 1; page <= hardCapPages; page++) {
      if (targetProfiles && saved >= targetProfiles) { logAgent(`Hit target of ${targetProfiles} scraped profile(s). Stopping.`); break; }
      if (shortlistCount >= targetShortlist) { logAgent(`Hit target ${targetShortlist}. Stopping.`); break; }

      if (page > 1) {
        logAgent(`Page ${page}: navigating to next page…`);
        const tabBeforeNav = await chrome.tabs.get(tab.id).catch(() => null);
        const urlBeforeNav = tabBeforeNav?.url || "";
        const [clk] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const sels = [
              'button[aria-label="Next"]:not([disabled])',
              'a[aria-label="Next"]',
              'button.next:not([disabled])',
              'a.next',
              '[class*="pagination"] a:last-child',
              '[class*="Pagination"] button:not([disabled]):last-child',
              'a[rel="next"]',
              'li.next a',
            ];
            for (const s of sels) { const b = document.querySelector(s); if (b) { b.scrollIntoView(); b.click(); return true; } }
            const nx = Array.from(document.querySelectorAll('a, button')).find(
              (b) => /^\s*(next|›|»)\s*$/i.test(b.innerText?.trim() || b.textContent?.trim() || "") && !b.disabled);
            if (nx) { nx.scrollIntoView(); nx.click(); return true; }
            return false;
          },
        });
        if (clk?.result) {
          await waitForTabLoad(tab.id, 25000);
        } else {
          // Fallback: increment page param in URL (?page=N or ?pageNo=N)
          try {
            const u = new URL(urlBeforeNav);
            const param = u.searchParams.has("page") ? "page" : u.searchParams.has("pageNo") ? "pageNo" : null;
            if (!param) { logAgent("No next-page button or URL param — stopping."); break; }
            u.searchParams.set(param, String(parseInt(u.searchParams.get(param) || "1", 10) + 1));
            await chrome.tabs.update(tab.id, { url: u.href });
            await waitForTabLoad(tab.id, 25000);
          } catch {
            logAgent("Cannot navigate to next page — stopping.");
            break;
          }
        }
      }

      const [out] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
      let cands = out?.result;
      if (cands && typeof cands.then === "function") cands = await cands;
      if (!Array.isArray(cands)) cands = [];
      cands = cands.filter((c) => { const k = c.profileUrl || c.name; if (seen.has(k)) return false; seen.add(k); return true; });
      logAgent(`Page ${page}: found ${cands.length} new profile(s).`);
      agentState.total += cands.length;
      if (!cands.length && page > 1) { logAgent("Empty page — stopping."); break; }

      for (const c of cands) {
        if (targetProfiles && saved >= targetProfiles) break;
        if (shortlistCount >= targetShortlist) break;
        let enriched = { ...c };

        // Option 1 (Instahyre + Naukri): open profile in a NEW tab by clicking
        // the name link, deep-scrape it, then close. Falls back to card-only
        // data if no new tab opens within the timeout (Option 2).
        const profileScript = portal === "instahyre" ? "content/instahyre-profile.js"
                            : portal === "naukri"    ? "content/naukri-profile.js"
                            : null;
        if (profileScript && (c.profileUrl || typeof c.cardIndex === "number")) {
          try {
            logAgent(`Opening ${c.name || "(no name)"} in new tab…`);
            const profileTabId = await openProfileInNewTab(portal, tab.id, c.profileUrl, c.cardIndex);
            if (profileTabId) {
              // Capture real tab URL as profileUrl (covers javascript: href cases)
              const pTab = await chrome.tabs.get(profileTabId).catch(() => null);
              if (pTab?.url && /^https?:\/\//i.test(pTab.url)) enriched.profileUrl = pTab.url;
              try {
                const [pOut] = await chrome.scripting.executeScript({
                  target: { tabId: profileTabId },
                  files: [profileScript],
                });
                let p = pOut?.result;
                if (p && typeof p.then === "function") p = await p;
                if (p) {
                  enriched = {
                    ...enriched,
                    name: p.name || enriched.name,
                    headline: p.headline || enriched.headline,
                    company: p.company || enriched.company,
                    companies: (p.companies?.length ? p.companies : (enriched.companies || (enriched.company ? [enriched.company] : []))),
                    location: p.location || enriched.location,
                    experienceText: p.experienceText,
                    skillsList: (p.skillsList?.length ? p.skillsList : enriched.keySkills) || [],
                    availability: p.availability || enriched.availability || "active",
                    openToWork: !!p.openToWork || !!enriched.openToWork,
                    profileUrl: p.profileUrl || enriched.profileUrl,
                  };
                }
              } catch (e) { logAgent("Profile scrape failed: " + (e.message || e)); }
              try { await chrome.tabs.remove(profileTabId); } catch {}
            } else {
              logAgent("Profile tab didn't open — scoring from results-card data only.");
            }
          } catch (e) { logAgent("Open-profile failed: " + (e.message || e)); }
        }

        const cand = { id: uid(), searchId: search.id, roleId, portal, ...enriched, createdAt: Date.now() };
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const s = await scoreCandidate({ role, candidate: cand, workMode: role.workMode, targetCompanies: agentCompanies, ...getHardExcludes(role) });
            Object.assign(cand, s); cand.scoreError = null; break;
          } catch (e) {
            cand.scoreError = String(e.message || e);
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
        const score = cand.score || 0;
        if (score >= 80) { cand.bucket = "auto"; cand.shortlisted = true; shortlistCount++; }
        else if (score >= 70) { cand.bucket = "review"; cand.shortlisted = false; }
        else { cand.bucket = "reject"; cand.shortlisted = false; }
        await append("candidates", cand);
        saved++; agentState.processed = saved;
        logAgent(`Saved ${cand.name || "(no name)"} — score ${cand.score ?? "?"} (${cand.bucket}). Shortlist ${shortlistCount}/${targetShortlist}.`);
        chrome.runtime.sendMessage({ type: "agentCandidate", candidate: cand }).catch(() => {});
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    await update("searches", search.id, { status: "done", finishedAt: Date.now(), count: saved });
    logAgent(`Done. Saved ${saved}, auto-shortlisted ${shortlistCount}.`);
    return { ok: true, saved, shortlisted: shortlistCount };
  } catch (e) {
    await update("searches", search.id, { status: "error", finishedAt: Date.now(), error: String(e.message || e) });
    logAgent("Error: " + (e.message || e));
    throw e;
  } finally {
    agentState.running = false;
  }
}

// Open a Naukri candidate profile by simulating a click on its name link in the
// results tab. Naukri opens the profile in a new tab (target=_blank). We capture
// that new tab via chrome.tabs.onCreated, wait for it to finish loading, and
// return its tabId. Resolves to null if no new tab opens within timeoutMs.
// Per-portal selectors used by openProfileInNewTab to find the candidate card
// and the name/title link inside it (which both portals open as target=_blank).
const PROFILE_CARD_SELECTORS = {
  naukri: ['[data-sa-idx]', '.candidate-tuple', '.candidateTuple', '.cand-tuple', '[class*="CandidateCard"]', '[class*="candidate-card"]', '.srp-tuple', '.profile-tuple', '.profileTuple', '.cvTuple', '.resTuple', '.tuple', '[class*="tuple" i]', '[id^="tuple"]'],
  instahyre: ['.candidate-card', '.candidate-row', '[class*="CandidateCard"]', '[class*="candidate-tile"]', 'div[ng-repeat*="candidate"]', 'li.candidate'],
};
const PROFILE_LINK_SELECTORS = {
  naukri: ['a[href*="/resdex/profile/"]', 'a[href*="/resdex/cv/"]', 'a[href*="/profile/"]', 'a[href*="/cv/"]', 'a[href*="candidate"]', 'a[href*="resume"]', 'a[target="_blank"]', 'a.title', '.candidate-name a', '.name a', '[class*="Name"] a', '[class*="name" i] a', 'h3 a', 'h4 a', '[onclick][class*="name" i]', '[role="link"][class*="name" i]', 'a'],
  instahyre: ['a[href*="/candidate/"]', 'a[href*="/profile/"]', 'a[href*="/c/"]', 'a[target="_blank"][href*="instahyre"]', '.candidate-name a', '[class*="Name"] a', 'h3 a', 'h4 a', 'a.title'],
};

async function openProfileInNewTab(portal, resultsTabId, profileUrl, cardIndex, timeoutMs = 12000) {
  // Primary path: browser security gates synthetic events behind user activation,
  // so synthetic clicks never open new tabs. Use chrome.tabs.create directly.
  if (profileUrl && /^https?:\/\//i.test(profileUrl)) {
    const t = await chrome.tabs.create({ url: profileUrl, active: false, openerTabId: resultsTabId }).catch(() => null);
    if (t?.id) {
      await waitForTabLoad(t.id, 20000);
      return t.id;
    }
  }

  // Fallback: click-simulation when profileUrl is missing or invalid.
  // Attempts to find the name link in the results page and extract its href,
  // then opens that href via chrome.tabs.create.
  const cardSels = PROFILE_CARD_SELECTORS[portal] || PROFILE_CARD_SELECTORS.naukri;
  const linkSels = PROFILE_LINK_SELECTORS[portal] || PROFILE_LINK_SELECTORS.naukri;
  let clickedHref = "";
  const newTabId = await new Promise(async (resolve) => {
    let resolved = false;
    const finish = (id) => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onCreated.removeListener(onCreated);
      resolve(id || null);
    };
    const onCreated = (t) => {
      if (t.openerTabId === resultsTabId) finish(t.id);
    };
    chrome.tabs.onCreated.addListener(onCreated);
    setTimeout(() => finish(null), timeoutMs);

    try {
      const [clickOut] = await chrome.scripting.executeScript({
        target: { tabId: resultsTabId },
        func: (urlPart, idx, cardSels, linkSels) => {
          const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
          const looksLikeName = (s) => /^[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,4}$/.test(clean(s).replace(/\b(hidden gem|actively applying|open to work)\b/ig, "").trim());
          const abs = (h) => { try { return h ? new URL(h, location.href).href : ""; } catch { return h || ""; } };
          let card = null;
          if (typeof idx === "number") {
            card = document.querySelector(`[data-sa-idx="${idx}"], [data-saIdx="${idx}"]`);
          }
          if (!card && urlPart) {
            const tail = urlPart.split("/").filter(Boolean).pop()?.replace(/["\\]/g, "");
            const a = tail ? document.querySelector(`a[href*="${tail}"]`) : null;
            card = a?.closest('li, article, section, div') || null;
          }
          if (!card) {
            const all = Array.from(document.querySelectorAll(cardSels.join(",")));
            card = all[idx || 0];
          }
          if (!card) return { ok: false, reason: "no-card" };
          let link = null;
          for (const s of linkSels) { link = card.querySelector(s); if (link) break; }
          if (!link) link = Array.from(card.querySelectorAll('a, [role="link"], [onclick]')).find((el) => looksLikeName(el.textContent || el.innerText || ""));
          if (!link) return { ok: false, reason: "no-link" };
          // Prefer a real href; javascript: hrefs are useless for navigation.
          const rawHref =
            (/javascript:/i.test(link.href || "") ? "" : link.href) ||
            (link.getAttribute?.("href") || "").replace(/^javascript:.*/i, "") ||
            link.dataset?.href || link.dataset?.url || link.dataset?.profileUrl ||
            card.getAttribute?.("data-href") || card.getAttribute?.("data-url") ||
            card.getAttribute?.("data-profile-url") || urlPart || "";
          const href = abs(rawHref);
          return { ok: /^https?:\/\//i.test(href), href };
        },
        args: [profileUrl || "", typeof cardIndex === "number" ? cardIndex : null, cardSels, linkSels],
      });
      clickedHref = clickOut?.result?.href || "";
    } catch {}
    finish(null);
  });

  if (clickedHref && /^https?:\/\//i.test(clickedHref)) {
    const t = await chrome.tabs.create({ url: clickedHref, active: false, openerTabId: resultsTabId }).catch(() => null);
    if (t?.id) {
      await waitForTabLoad(t.id, 20000);
      return t.id;
    }
  }
  if (!newTabId) return null;
  await waitForTabLoad(newTabId, 20000);
  return newTabId;
}

// Backward-compat alias used by the Naukri agent.
const openNaukriProfileInNewTab = (resultsTabId, profileUrl, cardIndex, timeoutMs) =>
  openProfileInNewTab("naukri", resultsTabId, profileUrl, cardIndex, timeoutMs);

// ===== Naukri Resdex agent (per Naukri_Hand_book) =====
// Operates on the active Naukri tab. If on launcher home, clicks "Search Resumes".
// Then sets up filters per the handbook (boolean, exp, location, diversity, display, active=60d),
// clicks Search, scrapes each result, opens each profile to deep-scrape, scores, saves.
async function runNaukriAgent({ roleId, targetShortlist = 10, hardCapPages = 10, maxProfiles = 0 }) {
  if (agentState.running) throw new Error("Agent already running");
  const roles = await getAll("roles", []);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw new Error("Role not found");

  // Find a Naukri tab
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/naukri\.com/i.test(tab.url || "")) {
    const existing = (await chrome.tabs.query({ url: "*://*.naukri.com/*" }))[0];
    if (existing?.id) { tab = existing; await chrome.tabs.update(tab.id, { active: true }); }
    else throw new Error("Open Naukri (logged in) in a tab first.");
  }

  agentState.running = true;
  agentState.processed = 0; agentState.total = 0; agentState.log = []; agentState.roleId = roleId;
  logAgent(`Starting Naukri agent for role: ${role.title}`);

  const search = await append("searches", {
    id: uid(), roleId, portal: "naukri", status: "running",
    query: `(agent) ${role.title}`, startedAt: Date.now(), count: 0,
  });

  let shortlistCount = 0, saved = 0;
  let returnTabUrl = null; // remember results URL so we can navigate back after profile views

  try {
    logAgent("Starting scrape…");


    await new Promise((r) => setTimeout(r, 1500));
    returnTabUrl = (await chrome.tabs.get(tab.id)).url;

    const seen = new Set();
    const targetProfiles = Number(maxProfiles) || 0;
    for (let page = 1; page <= hardCapPages; page++) {
      if (targetProfiles && saved >= targetProfiles) { logAgent(`Hit target of ${targetProfiles} scraped profile(s). Stopping.`); break; }
      if (shortlistCount >= targetShortlist) { logAgent(`Hit target ${targetShortlist}. Stopping.`); break; }

      if (page > 1) {
        // navigate back to results page if a profile view changed url
        const cur = (await chrome.tabs.get(tab.id)).url;
        if (returnTabUrl && cur !== returnTabUrl) {
          await chrome.tabs.update(tab.id, { url: returnTabUrl });
          await waitForTabLoad(tab.id, 25000);
        }
        logAgent(`Page ${page}: navigating to next page…`);
        // Primary: click Next button
        const [clk] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const sels = [
              'a.fright.fr.btn-secondary[href*="page="]',
              'a[title="Next"]', 'a.next', 'a.pagination-next',
              'button[aria-label="Next"]:not([disabled])',
              '[class*="pagination"] a:last-child',
              '[class*="Pagination"] button:not([disabled]):last-child',
            ];
            for (const s of sels) { const b = document.querySelector(s); if (b) { b.scrollIntoView(); b.click(); return true; } }
            const nx = Array.from(document.querySelectorAll('a, button')).find(
              (b) => /^\s*(next|›|»)\s*$/i.test(b.innerText || b.textContent || "") && !b.disabled);
            if (nx) { nx.scrollIntoView(); nx.click(); return true; }
            return false;
          },
        });
        if (clk?.result) {
          await waitForTabLoad(tab.id, 25000);
        } else {
          // Fallback: increment pageNo in URL (Naukri uses ?pageNo=N)
          try {
            const u = new URL(returnTabUrl);
            const curPage = parseInt(u.searchParams.get("pageNo") || "1", 10);
            u.searchParams.set("pageNo", String(curPage + 1));
            await chrome.tabs.update(tab.id, { url: u.href });
            await waitForTabLoad(tab.id, 25000);
          } catch {
            logAgent("Cannot navigate to next page — stopping.");
            break;
          }
        }
        returnTabUrl = (await chrome.tabs.get(tab.id)).url;
      }

      // Scrape results list
      const [out] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/naukri-resdex.js"],
      });
      let cands = out?.result;
      if (cands && typeof cands.then === "function") cands = await cands;
      if (!Array.isArray(cands)) cands = [];
      cands = cands.filter((c) => { const k = c.profileUrl || c.name; if (!k || seen.has(k)) return false; seen.add(k); return true; });
      logAgent(`Page ${page}: found ${cands.length} new profile(s).`);
      agentState.total += cands.length;
      if (!cands.length && page > 1) { logAgent("Empty page — stopping."); break; }

      for (const c of cands) {
        if (targetProfiles && saved >= targetProfiles) break;
        if (shortlistCount >= targetShortlist) break;
        let enriched = { ...c };

        // Option 1: open profile in a NEW tab by simulating a click on the name link
        // (Naukri's name links are target="_blank"). Falls back to card-only data if
        // no new tab opens within timeout (Option 2).
        if (c.profileUrl || typeof c.cardIndex === "number") {
          try {
            logAgent(`Opening ${c.name || "(no name)"} in new tab…`);
            const profileTabId = await openNaukriProfileInNewTab(tab.id, c.profileUrl, c.cardIndex);
            if (profileTabId) {
              // Capture the real tab URL as profileUrl (covers javascript: href cases)
              const pTab = await chrome.tabs.get(profileTabId).catch(() => null);
              if (pTab?.url && /^https?:\/\//i.test(pTab.url)) enriched.profileUrl = pTab.url;
              try {
                const [pOut] = await chrome.scripting.executeScript({
                  target: { tabId: profileTabId },
                  files: ["content/naukri-profile.js"],
                });
                let p = pOut?.result;
                if (p && typeof p.then === "function") p = await p;
                if (p) {
                  enriched = {
                    ...enriched,
                    name: p.name || enriched.name,
                    headline: p.headline || enriched.headline,
                    company: p.company || enriched.company,
                    companies: (p.companies?.length ? p.companies : (enriched.companies || (enriched.company ? [enriched.company] : []))),
                    location: p.location || enriched.location,
                    experienceText: p.experienceText,
                    skillsList: (p.skillsList?.length ? p.skillsList : enriched.keySkills) || [],
                    availability: p.availability || enriched.availability || "active",
                    openToWork: !!p.openToWork || !!enriched.openToWork,
                  };
                }
              } catch (e) { logAgent("Profile scrape failed: " + (e.message || e)); }
              try { await chrome.tabs.remove(profileTabId); } catch {}
            } else {
              logAgent("Profile tab didn't open — scoring from results-card data only.");
            }
          } catch (e) { logAgent("Open-profile failed: " + (e.message || e)); }
        }

        const cand = { id: uid(), searchId: search.id, roleId, portal: "naukri", ...enriched, createdAt: Date.now() };
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const s = await scoreCandidate({ role, candidate: cand, workMode: role.workMode, targetCompanies: agentCompanies, ...getHardExcludes(role) });
            Object.assign(cand, s); cand.scoreError = null; break;
          } catch (e) {
            cand.scoreError = String(e.message || e);
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
        const score = cand.score || 0;
        if (score >= 80) { cand.bucket = "auto"; cand.shortlisted = true; shortlistCount++; }
        else if (score >= 70) { cand.bucket = "review"; cand.shortlisted = false; }
        else { cand.bucket = "reject"; cand.shortlisted = false; }
        await append("candidates", cand);
        saved++; agentState.processed = saved;
        logAgent(`Saved ${cand.name || "(no name)"} — score ${cand.score ?? "?"} (${cand.bucket}). Shortlist ${shortlistCount}/${targetShortlist}.`);
        chrome.runtime.sendMessage({ type: "agentCandidate", candidate: cand }).catch(() => {});
        await new Promise((r) => setTimeout(r, 600));
      }

      // Profiles opened in their own tabs — results tab stays put across pagination.
    }

    await update("searches", search.id, { status: "done", finishedAt: Date.now(), count: saved });
    logAgent(`Done. Saved ${saved}, auto-shortlisted ${shortlistCount}.`);
    return { ok: true, saved, shortlisted: shortlistCount };
  } catch (e) {
    await update("searches", search.id, { status: "error", finishedAt: Date.now(), error: String(e.message || e) });
    logAgent("Error: " + (e.message || e));
    throw e;
  } finally {
    agentState.running = false;
  }
}

async function runLinkedInAgentAllRoles(opts = {}) {
  const roles = await getAll("roles", []);
  const results = [];
  for (const r of roles) {
    try {
      const res = await runLinkedInAgent({ ...opts, roleId: r.id });
      results.push({ roleId: r.id, ...res });
    } catch (e) {
      results.push({ roleId: r.id, ok: false, error: String(e.message || e) });
    }
  }
  return { ok: true, results };
}

// =====================================================================
// Sourcing-strategy generator: 12 booleans (4 modes × 3 portals) + reasoning.
// =====================================================================
const PORTAL_LIMITS = {
  linkedin:  { ideal: [250, 400], hard: 600 },
  naukri:    { ideal: [200, 500], hard: 500 },
  instahyre: { ideal: [500, 800], hard: 900 },
};
const MODES = ["precision", "expansion", "highPotential", "hiddenGem"];
const PORTALS = ["linkedin", "naukri", "instahyre"];

function localBooleanFallback(portal, role, hard) {
  const q = (s) => `"${String(s).replace(/"/g, "")}"`;
  const musts = (hard.mustHaveKeywords.length ? hard.mustHaveKeywords : (role.skills || []).slice(0, 3)).filter(Boolean);
  const mustGroups = musts.slice(0, 4).map((m) => `(${q(m)})`);
  const head = mustGroups.length ? mustGroups.join(" AND ") : `(${q(role.title || "engineer")})`;
  const noise = ["intern", "fresher", "trainee"];
  const notTerms = [...noise, ...hard.excludeKeywords].map(q).concat(hard.excludeCompaniesHard.map(q));
  return `${head}${notTerms.length ? ` NOT (${notTerms.join(" OR ")})` : ""}`.trim();
}

function computeOptimizationScore(portal, b, hard) {
  if (!b) return 0;
  const lim = PORTAL_LIMITS[portal];
  let score = 100;
  const len = b.length;
  if (len > lim.hard) score -= 20;
  else if (len < lim.ideal[0] || len > lim.ideal[1]) score -= 10;
  // must-have coverage
  const lower = b.toLowerCase();
  const missing = (hard.mustHaveKeywords || []).filter((m) => m && !lower.includes(m.toLowerCase()));
  if (missing.length) score -= 15;
  // NOT clause present?
  if (!/\bNOT\s*\(/i.test(b)) score -= 10;
  return Math.max(0, Math.min(100, score));
}

function trimNaukriBoolean(boolean, hard) {
  const MAX = 500;
  if (boolean.length <= MAX) return boolean;
  const orig = boolean.length;
  if (!hard.includeIT) {
    const dropOrder = [...IT_SERVICES_EXCLUDE].reverse().filter((c) => !IT_SERVICES_EXCLUDE_TOP.includes(c));
    for (const c of dropOrder) {
      const rx = new RegExp(`\\s*OR\\s*"${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i");
      boolean = boolean.replace(rx, "");
      if (boolean.length <= MAX) break;
    }
  }
  if (boolean.length > MAX && !hard.includeIT) {
    for (const c of [...IT_SERVICES_EXCLUDE_TOP].reverse()) {
      const rx = new RegExp(`\\s*OR\\s*"${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i");
      boolean = boolean.replace(rx, "");
      if (boolean.length <= MAX) break;
    }
  }
  if (boolean.length > MAX) {
    const mustLower = (hard.mustHaveKeywords || []).map((m) => m.toLowerCase());
    const notIdx = boolean.search(/\bNOT\s*\(/i);
    const head = notIdx > 0 ? boolean.slice(0, notIdx).trim() : boolean;
    const tail = notIdx > 0 ? boolean.slice(notIdx) : "";
    const groups = head.split(/\s+AND\s+/i);
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i].toLowerCase();
      if (mustLower.some((m) => m && g.includes(m))) continue;
      groups.splice(i, 1);
      boolean = (groups.join(" AND ") + " " + tail).trim();
      if (boolean.length <= MAX) break;
    }
  }
  const o = (boolean.match(/\(/g) || []).length;
  const c = (boolean.match(/\)/g) || []).length;
  if (c < o) boolean += ")".repeat(o - c);
  if (boolean.length !== orig) {
    // best-effort log; agentState may be unrelated here
    try { console.log(`[strategy] Naukri trim ${orig}→${boolean.length}`); } catch {}
  }
  return boolean;
}

function injectTargetCompanies(boolean, companies, maxCount) {
  if (!companies || !companies.length || maxCount <= 0) return boolean;
  const lower = boolean.toLowerCase();
  // Top-up: take recruiter companies in priority order, skipping ones already present.
  const present = companies.filter((c) => c && lower.includes(c.toLowerCase()));
  const missing = companies.filter((c) => c && !lower.includes(c.toLowerCase()));
  // Final inline set = already-present (kept implicitly via existing string) + new missing ones up to maxCount.
  const slotsLeft = Math.max(0, maxCount - present.length);
  const toAdd = missing.slice(0, slotsLeft);
  if (!toAdd.length) return boolean; // already saturated
  const co = toAdd.map((c) => `"${String(c).replace(/"/g, "")}"`).join(" OR ");
  const notIdx = boolean.search(/\bNOT\s*\(/i);
  // Detect an existing company OR-group we can extend instead of appending a duplicate AND-group.
  const existingGroup = present.length
    ? boolean.match(new RegExp(`\\(([^()]*"${present[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^()]*)\\)`, "i"))
    : null;
  if (existingGroup) {
    return boolean.replace(existingGroup[0], `(${existingGroup[1]} OR ${co})`);
  }
  return notIdx > 0
    ? `${boolean.slice(0, notIdx).trim()} AND (${co}) ${boolean.slice(notIdx)}`
    : `${boolean} AND (${co})`;
}

function finalizeStrategy(strategy, role, hard, companies = [], categorized = null) {
  if (!strategy || typeof strategy !== "object") strategy = {};
  strategy.portals = strategy.portals || {};
  // Per-mode policy on whether to inject the recruiter's selected companies into the boolean.
  // Naukri uses a dedicated company field, so we never stuff companies into the keyword boolean.
  const injectPolicy = {
    linkedin:  { precision: 15, expansion: 12, highPotential: 6, hiddenGem: 0 },
    instahyre: { precision: 12, expansion: 10, highPotential: 5, hiddenGem: 0 },
    naukri:    { precision: 0,  expansion: 0,  highPotential: 0, hiddenGem: 0 },
  };
  for (const p of PORTALS) {
    strategy.portals[p] = strategy.portals[p] || {};
    for (const m of MODES) {
      const block = strategy.portals[p][m] = strategy.portals[p][m] || {};
      let b = (block.boolean || "").toString().trim().replace(/\s*\n+\s*/g, " ");
      if (!looksLikeBoolean(b)) {
        b = localBooleanFallback(p, role, hard);
        block._fallback = true;
      }
      const cap = injectPolicy[p]?.[m] || 0;
      if (cap > 0 && companies.length) b = injectTargetCompanies(b, companies, cap);
      b = injectHardExcludes(b, hard);
      if (p === "naukri") b = trimNaukriBoolean(b, hard);
      block.boolean = b;
      block.charCount = b.length;
      block.optimizationScore = computeOptimizationScore(p, b, hard);
      block.signalsPrioritized = Array.isArray(block.signalsPrioritized) ? block.signalsPrioritized : [];
      block.adjacentPoolsAdded = Array.isArray(block.adjacentPoolsAdded) ? block.adjacentPoolsAdded : [];
      block.exclusionsApplied = Array.isArray(block.exclusionsApplied) ? block.exclusionsApplied : [];
      block.patternsUsed = Array.isArray(block.patternsUsed) ? block.patternsUsed : [];
      block.suggestedFilters = block.suggestedFilters && typeof block.suggestedFilters === "object" ? block.suggestedFilters : {};
      // Surface recruiter target companies in suggestedFilters.currentCompanies (esp. for Naukri/LinkedIn UI).
      if (companies.length && (!Array.isArray(block.suggestedFilters.currentCompanies) || !block.suggestedFilters.currentCompanies.length)) {
        block.suggestedFilters.currentCompanies = companies.slice(0, 25);
      }
      // Tag pattern usage with category names so "Why this boolean" shows category influence.
      if (categorized && categorized.categoryNames && categorized.categoryNames.length) {
        const tags = categorized.categoryNames.map((n) => `Category: ${n}`);
        for (const t of tags) if (!block.patternsUsed.includes(t)) block.patternsUsed.push(t);
      }
      block.rationale = block.rationale || "";
    }
  }
  return strategy;
}

async function generateStrategy({ roleId }) {
  const roles = await getAll("roles", []);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw new Error("Role not found");
  const companies = await resolveTargetCompanies(role);
  const categorized = await resolveCategorizedCompanies(role);
  const hard = getHardExcludes(role);
  const ai = await generateSourcingStrategy({
    role,
    companies,
    categorized,
    mustHaveKeywords: hard.mustHaveKeywords,
    excludeKeywords: hard.excludeKeywords,
    excludeCompaniesHard: hard.excludeCompaniesHard,
    idealResumeExcerpts: hard.idealResumeExcerpts,
    recruiterNotes: role.recruiterNotes || "",
    companyStage: role.companyStage || "",
  });
  const finalized = finalizeStrategy(ai, role, hard, companies, categorized);
  // Persist (replace any existing strategy for this role).
  const all = await getAll("strategies", []);
  const next = all.filter((s) => s.roleId !== roleId);
  next.push({ id: uid(), roleId, createdAt: Date.now(), strategy: finalized });
  await setAll("strategies", next);
  return { ok: true, strategy: finalized };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "kick") { processNext(); sendResponse({ ok: true }); return true; }
  if (msg?.type === "ping") { sendResponse({ ok: true }); return true; }
  if (msg?.type === "bulkOpen") { bulkOpen(msg.urls).then(() => sendResponse({ ok: true })); return true; }
  if (msg?.type === "downloadResumes") {
    downloadResumes(msg.ids).then((r) => sendResponse({ ok: true, results: r }));
    return true;
  }
  if (msg?.type === "captureActiveTab") {
    captureActiveTab(msg.roleId)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === "runLinkedInAgent") {
    runLinkedInAgent(msg.opts || {})
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === "runLinkedInAgentAllRoles") {
    runLinkedInAgentAllRoles(msg.opts || {})
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === "runPortalAgent") {
    const fn = (msg.opts?.portal === "naukri") ? runNaukriAgent : runPortalAgent;
    fn(msg.opts || {})
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === "runNaukriAgent") {
    runNaukriAgent(msg.opts || {})
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === "generateStrategy") {
    generateStrategy(msg.opts || {})
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === "agentState") { sendResponse({ ...agentState }); return true; }
  return true;
});

// Tick every minute in case service worker restarts
chrome.alarms?.create?.("tick", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(() => processNext());
