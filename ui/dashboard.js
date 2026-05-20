import { getAll, setAll, append, update, remove, uid, getSettings, saveSettings } from "../lib/storage.js";
import { parseJD, generateSearchStrings } from "../lib/agents.js";
import { chatShortlist } from "../lib/chat.js";
import { PROVIDERS } from "../lib/ai.js";

const app = document.getElementById("app");
const toast = (msg, ms = 2500) => {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms);
};
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
};

function setActiveNav() {
  document.querySelectorAll("nav a").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("href") === location.hash);
  });
}
window.addEventListener("hashchange", route);
async function route() {
  setActiveNav();
  app.innerHTML = "";
  const hash = location.hash || "#/roles";
  const [path, ...rest] = hash.replace(/^#\//, "").split("/");
  try {
    if (path === "roles") return rest[0] ? renderRoleDetail(rest[0]) : renderRoles();
    if (path === "searches") return renderSearches();
    if (path === "candidates") return renderCandidates();
    if (path === "companies") return renderCompanies();
    if (path === "settings") return renderSettings();
    location.hash = "#/roles";
  } catch (e) { app.appendChild(h("div", { class: "card" }, "Error: " + e.message)); }
}

// ---------- ROLES ----------
async function renderRoles() {
  const roles = await getAll("roles", []);
  const candidates = await getAll("candidates", []);
  const queue = await getAll("queue", []);
  app.appendChild(h("div", {},
    h("h1", {}, "Roles"),
    h("p", { class: "sub" }, "Upload a JD, generate search strings, run searches across LinkedIn, Naukri, and Instahyre."),
    h("div", { class: "kpi" },
      kpi("Roles", roles.length),
      kpi("Queued jobs", queue.filter(q => q.status === "queued").length),
      kpi("Running", queue.filter(q => q.status === "running").length),
      kpi("Candidates", candidates.length),
    ),
    h("div", { class: "btnrow" },
      h("button", { onclick: () => createRole() }, "+ New role"),
      h("button", { class: "ghost", onclick: () => {
        if (!confirm("Run LinkedIn agent for ALL roles sequentially? Make sure you're logged into LinkedIn.")) return;
        toast("Agent starting on all roles…", 4000);
        chrome.runtime.sendMessage({ type: "runLinkedInAgentAllRoles", opts: { targetShortlist: 10 } }, (resp) => {
          if (!resp?.ok) toast("Error: " + (resp?.error || "unknown"), 6000);
          else toast(`Done. ${resp.results?.length || 0} role(s) processed.`, 5000);
        });
      } }, "▶ Run LinkedIn agent on ALL roles"),
    ),
    h("div", { class: "card", style: "margin-top:16px;padding:0" },
      roles.length === 0
        ? h("div", { class: "empty" }, "No roles yet. Create one to begin.")
        : table(["Title", "Skills", "Locations", "Categories", ""],
            roles.map(r => [
              h("a", { class: "link", href: `#/roles/${r.id}` }, r.title || "(untitled)"),
              (r.skills || []).slice(0, 4).join(", ") + ((r.skills||[]).length > 4 ? "…" : ""),
              (r.locations || []).join(", "),
              (r.categories || []).join(", "),
              h("button", { class: "ghost", onclick: async (e) => { e.preventDefault(); if (confirm("Delete role?")) { await remove("roles", r.id); route(); } } }, "Delete"),
            ]))
    ),
  ));
}

async function createRole() {
  const role = { id: uid(), title: "Untitled role", jdText: "", parsed: {}, skills: [], locations: [], expMin: 0, expMax: 0, categories: [], customCompanies: [], mustHave: [], excludeKeywords: [], excludeCompanies: [], idealResumes: [], includeITServices: false, recruiterNotes: "", companyStage: "", createdAt: Date.now() };
  await append("roles", role);
  location.hash = `#/roles/${role.id}`;
}

async function renderRoleDetail(id) {
  const roles = await getAll("roles", []);
  const role = roles.find(r => r.id === id);
  if (!role) { location.hash = "#/roles"; return; }
  const lists = await getAll("companyLists", []);
  const strings = (await getAll("searchStrings", [])).filter(s => s.roleId === id);

  const f = {};
  const view = h("div", {});
  view.append(
    h("h1", {}, role.title || "Untitled role"),
    h("p", { class: "sub" }, "Edit details, paste or upload a JD, then generate and approve search strings."),

    h("div", { class: "card" },
      h("h2", {}, "Basics"),
      h("div", { class: "row" },
        field("Title", f.title = h("input", { value: role.title || "" })),
        field("Locations (comma sep)", f.locations = h("input", { value: (role.locations || []).join(", ") })),
      ),
      h("div", { class: "row" },
        field("Must-have skills (comma sep)", f.skills = h("input", { value: (role.skills || []).join(", ") })),
        field("Exp min (years)", f.expMin = h("input", { type: "number", value: role.expMin ?? 0 })),
        field("Exp max (years)", f.expMax = h("input", { type: "number", value: role.expMax ?? 0 })),
      ),
    ),

    h("div", { class: "card" },
      h("h2", {}, "Job description"),
      h("div", { class: "row" },
        h("div", {},
          h("label", {}, "Upload JD (txt, md, or paste below)"),
          h("input", { type: "file", accept: ".txt,.md,.text", onchange: async (e) => {
            const file = e.target.files[0]; if (!file) return;
            const text = await file.text();
            f.jd.value = text; toast("Loaded " + file.name);
          }}),
          h("div", { class: "muted", style: "font-size:11px;margin-top:6px" }, "PDF/DOCX: open the file, copy the text, paste below."),
        ),
        h("div", {},
          h("label", {}, "Or paste JD text"),
          f.jd = h("textarea", { placeholder: "Paste the job description here…" }, role.jdText || ""),
        ),
      ),
      h("div", { class: "btnrow" },
        h("button", { onclick: async () => {
          if (!f.jd.value.trim()) return toast("Paste or upload JD first");
          toast("Parsing JD with AI…");
          try {
            const parsed = await parseJD(f.jd.value);
            f.title.value = parsed.title || f.title.value;
            f.skills.value = (parsed.mustHaveSkills || []).join(", ");
            f.locations.value = (parsed.locations || []).join(", ");
            f.expMin.value = parsed.experienceMin ?? f.expMin.value;
            f.expMax.value = parsed.experienceMax ?? f.expMax.value;
            await update("roles", id, { parsed });
            await saveRole();
            toast("JD parsed.");
            route();
          } catch (e) { toast("AI error: " + e.message, 5000); }
        } }, "AI: Parse JD"),
        h("button", { onclick: () => {
          startAgentPanel(id);
          chrome.runtime.sendMessage({ type: "runLinkedInAgent", opts: { roleId: id, targetShortlist: 10 } }, (resp) => {
            if (!resp?.ok) toast("Error: " + (resp?.error || "unknown"), 6000);
            else toast(`Agent done. ${resp.shortlisted}/10 shortlisted, ${resp.saved} saved.`, 5000);
          });
          toast("Agent started on LinkedIn Recruiter…");
        } }, "▶ Run LinkedIn agent for this role"),
      ),
    ),

    agentPanel(),

    h("div", { class: "card" },
      h("h2", {}, "Refine the search"),
      h("p", { class: "muted", style: "margin-top:-4px" }, "Hard signals fed to the boolean builder and the resume scorer."),
      h("div", { class: "row" },
        field("Hard must-have keywords (comma sep)",
          f.must = h("input", { value: (role.mustHave || []).join(", "), placeholder: "e.g. kubernetes, golang" })),
        field("Exclude keywords (comma sep)",
          f.exKw = h("input", { value: (role.excludeKeywords || []).join(", "), placeholder: "e.g. support, qa, freelance" })),
      ),
      h("div", { class: "row" },
        field("Exclude companies (comma sep)",
          f.exCo = h("input", { value: (role.excludeCompanies || []).join(", "), placeholder: "e.g. Acme Corp" })),
        h("div", {},
          h("label", {}, (() => {
            f.incIT = h("input", { type: "checkbox" });
            f.incIT.checked = role.includeITServices === true;
            return f.incIT;
          })(), " Include IT services companies (TCS, Infosys, Wipro, etc.)"),
          h("div", { class: "muted", style: "font-size:11px;margin-top:6px" }, "Off by default — IT services firms are hard-excluded from results."),
        ),
      ),
      h("div", { style: "margin-top:12px" },
        h("label", {}, "Ideal profile resumes (paste text; up to 3)"),
        f.ideal = h("textarea", { rows: 8, placeholder: "Paste 1–3 sample/ideal resumes here. Separate multiple resumes with a line containing only '---'. The AI mines real-world title variants, tool synonyms, and adjacent skills from these." },
          (role.idealResumes || []).map((r) => `--- ${r.name || "resume"} ---\n${r.text || ""}`).join("\n\n")),
        h("div", { class: "muted", style: "font-size:11px;margin-top:6px" }, "Tip: paste plain text. Saved automatically when you click ‘Save role’."),
      ),
      h("div", { style: "margin-top:12px" },
        h("label", {}, "Recruiter notes (free-form context for the AI)"),
        f.notes = h("textarea", { rows: 4, placeholder: "e.g. 'Founding engineer profile, must have shipped 0→1. Avoid pure consultants.'" }, role.recruiterNotes || ""),
      ),
      h("div", { class: "row", style: "margin-top:12px" },
        field("Company stage preference", (() => {
          f.stage = h("select", {},
            ...[["", "Any"], ["seed", "Seed / Early"], ["growth", "Growth"], ["late", "Late-stage"], ["public", "Public"]].map(([v, l]) => h("option", { value: v }, l))
          );
          f.stage.value = role.companyStage || "";
          return f.stage;
        })()),
      ),
    ),

    h("div", { class: "card" },
      h("h2", {}, "Target company categories"),
      h("p", { class: "muted", style: "margin-top:-4px" }, "Select categories or pick individual companies. Focus categories pre-selected."),
      h("div", { class: "checkgrid" },
        ...lists.map(l => {
          const cb = h("input", { type: "checkbox" });
          cb.checked = role.categories?.includes(l.name) ?? l.isFocus;
          cb.dataset.name = l.name;
          return h("label", {}, cb, `${l.name} (${l.companies.length})${l.isFocus ? " ★" : ""}`);
        }),
      ),
      h("div", { style: "margin-top:12px" },
        field("Custom companies (comma sep, added to all selected)", f.custom = h("input", { value: (role.customCompanies || []).join(", "), placeholder: "e.g. Acme Corp, Beta Labs" })),
      ),
    ),

    await renderStrategyCard(view, id),
  );
  app.appendChild(view);

  async function regenStrategy() {
    await saveRole();
    toast("Generating sourcing strategy with AI… (may take 20-40s)", 6000);
    chrome.runtime.sendMessage({ type: "generateStrategy", opts: { roleId: id } }, (resp) => {
      if (!resp?.ok) return toast("Error: " + (resp?.error || "unknown"), 8000);
      toast("Strategy generated.");
      route();
    });
  }
  view.querySelectorAll("[data-strategy-action='regen']").forEach((b) => b.addEventListener("click", regenStrategy));
  view.querySelectorAll("[data-strategy-action='save']").forEach((b) => b.addEventListener("click", async () => { await saveRole(); toast("Saved"); }));

  async function saveRole() {
    const cats = Array.from(view.querySelectorAll(".checkgrid input:checked")).map(c => c.dataset.name);
    // Parse ideal-resumes textarea: split on lines that are only dashes (--- or longer).
    // Header lines like "--- name ---" are treated as separators; the name is captured.
    const idealRaw = (f.ideal?.value || "").trim();
    const idealResumes = [];
    if (idealRaw) {
      const sepRx = /^[ \t]*-{3,}.*$/gm;
      const headers = [];
      let m;
      while ((m = sepRx.exec(idealRaw)) !== null) {
        headers.push({ index: m.index, length: m[0].length, name: m[0].replace(/^[ \t-]+|[ \t-]+$/g, "").trim() });
      }
      const segments = [];
      if (!headers.length) {
        segments.push({ name: "", text: idealRaw });
      } else {
        if (headers[0].index > 0) {
          segments.push({ name: "", text: idealRaw.slice(0, headers[0].index).trim() });
        }
        for (let i = 0; i < headers.length; i++) {
          const start = headers[i].index + headers[i].length;
          const end = i + 1 < headers.length ? headers[i + 1].index : idealRaw.length;
          segments.push({ name: headers[i].name, text: idealRaw.slice(start, end).trim() });
        }
      }
      segments
        .filter((s) => s.text)
        .slice(0, 3)
        .forEach((s, i) => idealResumes.push({ name: s.name || `resume-${i + 1}`, text: s.text }));
    }
    await update("roles", id, {
      title: f.title.value.trim() || "Untitled",
      locations: csv(f.locations.value),
      skills: csv(f.skills.value),
      expMin: Number(f.expMin.value) || 0,
      expMax: Number(f.expMax.value) || 0,
      jdText: f.jd.value,
      categories: cats,
      customCompanies: csv(f.custom.value),
      mustHave: csv(f.must?.value || ""),
      excludeKeywords: csv(f.exKw?.value || ""),
      excludeCompanies: csv(f.exCo?.value || ""),
      includeITServices: !!(f.incIT && f.incIT.checked),
      recruiterNotes: (f.notes?.value || "").trim(),
      companyStage: f.stage?.value || "",
      idealResumes,
    });
  }
}

// ============================================================
// SOURCING STRATEGY UI
// ============================================================
const PORTAL_LABELS = { linkedin: "LinkedIn", naukri: "Naukri", instahyre: "Instahyre" };
const PORTAL_HARD_CAP = { linkedin: 600, naukri: 500, instahyre: 900 };
const MODE_ORDER = ["precision", "expansion", "highPotential", "hiddenGem"];
const MODE_LABELS = { precision: "Precision", expansion: "Expansion", highPotential: "High Potential", hiddenGem: "Hidden Gem" };
const MODE_HINTS = {
  precision: "Tight, exact-fit talent. Strong exclusions.",
  expansion: "Adjacent titles + transferable systems mixed in.",
  highPotential: "Trajectory + scale. Less pedigree-bound.",
  hiddenGem: "Underrated companies, ownership & complexity.",
};

function chips(items, cls = "badge") {
  return h("div", { style: "display:flex;flex-wrap:wrap;gap:6px;margin-top:6px" },
    ...(items || []).filter(Boolean).map((x) => h("span", { class: cls }, String(x))));
}
function collapsible(title, contentNode, openByDefault = false) {
  const det = h("details", { ...(openByDefault ? { open: "" } : {}) },
    h("summary", { style: "cursor:pointer;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em;padding:4px 0" }, title),
    contentNode,
  );
  return det;
}

function renderModeBlock(portal, mode, block) {
  const cap = PORTAL_HARD_CAP[portal];
  const score = Number(block.optimizationScore || 0);
  const scoreCls = score >= 80 ? "good" : score >= 60 ? "warn" : "bad";
  const charCls = (block.charCount || 0) > cap ? "bad" : "muted";
  const ta = h("textarea", { rows: 4, style: "font-family:ui-monospace,monospace;font-size:12px" }, block.boolean || "");
  const charNode = h("span", { class: charCls, style: "font-size:11px" }, `${block.charCount || 0} chars (cap ${cap})`);
  ta.addEventListener("input", () => { charNode.textContent = `${ta.value.length} chars (cap ${cap})`; charNode.className = (ta.value.length > cap ? "bad" : "muted"); });

  const filters = block.suggestedFilters || {};
  const filterChips = [];
  if (filters.location) filterChips.push(`Location: ${filters.location}`);
  if (filters.yearsMin || filters.yearsMax) filterChips.push(`Years: ${filters.yearsMin || 0}-${filters.yearsMax || "+"}`);
  if (Array.isArray(filters.seniority) && filters.seniority.length) filterChips.push(`Seniority: ${filters.seniority.join(" / ")}`);
  if (Array.isArray(filters.currentCompanies) && filters.currentCompanies.length) filterChips.push(`Current cos: ${filters.currentCompanies.slice(0, 6).join(", ")}${filters.currentCompanies.length > 6 ? "…" : ""}`);

  return h("div", { style: "border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--panel2);margin-bottom:10px" },
    h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap" },
      h("div", {},
        h("strong", {}, MODE_LABELS[mode]), " ",
        h("span", { class: `badge ${scoreCls}` }, `score ${score}`),
        block._fallback ? h("span", { class: "badge bad", style: "margin-left:6px" }, "fallback") : null,
      ),
      h("div", { style: "display:flex;align-items:center;gap:8px" },
        charNode,
        h("button", { class: "ghost", onclick: async () => {
          try { await navigator.clipboard.writeText(ta.value); toast("Copied. Paste it into the portal."); }
          catch { ta.focus(); ta.select(); toast("Select-and-copy: textarea highlighted."); }
        } }, "Copy"),
      ),
    ),
    h("div", { class: "muted", style: "font-size:11px;margin-bottom:6px" }, MODE_HINTS[mode]),
    ta,
    filterChips.length ? h("div", { style: "margin-top:8px" },
      h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px" }, "Suggested platform filters"),
      chips(filterChips),
    ) : null,
    collapsible("Why this boolean", h("div", { style: "padding:8px 0;font-size:12px" },
      block.rationale ? h("p", { style: "margin:0 0 8px" }, block.rationale) : null,
      block.signalsPrioritized?.length ? h("div", {}, h("strong", {}, "Signals prioritized: "), block.signalsPrioritized.join(", ")) : null,
      block.adjacentPoolsAdded?.length ? h("div", { style: "margin-top:4px" }, h("strong", {}, "Adjacent pools: "), block.adjacentPoolsAdded.join(", ")) : null,
      block.exclusionsApplied?.length ? h("div", { style: "margin-top:4px" }, h("strong", {}, "Exclusions: "), block.exclusionsApplied.join(", ")) : null,
      block.patternsUsed?.length ? h("div", { style: "margin-top:4px" }, h("strong", {}, "Patterns used: "), block.patternsUsed.join(", ")) : null,
    )),
  );
}

function renderPortalSection(portal, portalData) {
  return h("div", { class: "portal-pane", "data-portal": portal, style: "display:none" },
    ...MODE_ORDER.map((m) => renderModeBlock(portal, m, portalData?.[m] || {})),
  );
}

async function renderStrategyCard(view, roleId) {
  const strategies = await getAll("strategies", []);
  const found = strategies.filter((s) => s.roleId === roleId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  const strategy = found?.strategy;

  const card = h("div", { class: "card" },
    h("h2", {}, "Sourcing strategy"),
    h("p", { class: "muted", style: "margin-top:-4px" }, "Principal-recruiter playbook: hiring thesis, ideal-profile patterns, company intelligence, and 12 booleans (4 modes × 3 portals)."),
    h("div", { class: "btnrow" },
      h("button", { "data-strategy-action": "save" }, "Save role"),
      h("button", { class: "ghost", "data-strategy-action": "regen" }, strategy ? "Regenerate strategy" : "AI: Generate sourcing strategy"),
    ),
  );

  if (!strategy) {
    card.appendChild(h("p", { class: "muted", style: "margin-top:14px" }, "No strategy yet. Click ‘AI: Generate sourcing strategy’ — make sure JD, ideal resumes, must-haves, and target companies are filled in for best results."));
    return card;
  }

  // Hiring thesis
  const t = strategy.thesis || {};
  const thesisBody = h("div", { style: "padding:8px 0" },
    t.businessProblem ? h("p", { style: "margin:0 0 8px" }, h("strong", {}, "Business problem: "), t.businessProblem) : null,
    h("div", { class: "split" },
      h("div", {},
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase" }, "Must-win competencies"),
        chips(t.mustWinCompetencies),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "Non-negotiables"),
        chips(t.nonNegotiables, "badge bad"),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "Success indicators"),
        chips(t.successIndicators, "badge good"),
      ),
      h("div", {},
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase" }, "Builder vs operator"),
        h("div", {}, t.builderVsOperator || "—"),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "Domain complexity"),
        h("div", {}, t.domainComplexity || "—"),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "Scale expectations"),
        h("div", {}, t.scaleExpectations || "—"),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "False positives to avoid"),
        chips(t.falsePositives, "badge warn"),
      ),
    ),
    t.adjacentTalentPools?.length ? h("div", { style: "margin-top:10px" },
      h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase" }, "Adjacent talent pools"),
      chips(t.adjacentTalentPools),
    ) : null,
    t.transferableBackgrounds?.length ? h("div", { style: "margin-top:10px" },
      h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase" }, "Transferable backgrounds"),
      chips(t.transferableBackgrounds),
    ) : null,
  );
  card.appendChild(collapsible("Hiring thesis", thesisBody, true));

  // Patterns + companies
  const ip = strategy.idealProfilePatterns || {};
  const ci = strategy.companyIntelligence || {};
  const patternsBody = h("div", { style: "padding:8px 0" },
    h("div", { class: "split" },
      h("div", {},
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase" }, "High-signal titles"), chips(ip.highSignalTitles),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "Adjacent titles"), chips(ip.adjacentTitles),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "Recurring skills"), chips(ip.recurringSkills),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "Trajectory patterns"), chips(ip.trajectoryPatterns),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "Weak / noise signals"), chips([...(ip.weakSignals || []), ...(ip.noiseSignals || [])], "badge warn"),
      ),
      h("div", {},
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase" }, "Exact targets"), chips(ci.exactTargets, "badge good"),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "Adjacent companies"), chips(ci.adjacentCompanies),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "Transferable pools"), chips(ci.transferablePools),
        h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-top:10px" }, "Competitive pools"), chips(ci.competitivePools),
      ),
    ),
  );
  card.appendChild(collapsible("Ideal-profile patterns & company intelligence", patternsBody, false));

  // Portal tabs
  const tabs = h("div", { style: "display:flex;gap:6px;margin:14px 0 10px;border-bottom:1px solid var(--border)" });
  const panes = h("div", {});
  PORTALS_UI.forEach((p, i) => {
    const tab = h("button", { class: "ghost", style: "border-radius:6px 6px 0 0;border-bottom:0" }, PORTAL_LABELS[p]);
    const pane = renderPortalSection(p, strategy.portals?.[p]);
    if (i === 0) { tab.style.background = "var(--primary)"; tab.style.color = "#fff"; pane.style.display = "block"; }
    tab.addEventListener("click", () => {
      tabs.querySelectorAll("button").forEach((b) => { b.style.background = ""; b.style.color = ""; });
      tab.style.background = "var(--primary)"; tab.style.color = "#fff";
      panes.querySelectorAll(".portal-pane").forEach((el) => { el.style.display = el.getAttribute("data-portal") === p ? "block" : "none"; });
    });
    tabs.appendChild(tab);
    panes.appendChild(pane);
  });
  card.appendChild(tabs);
  card.appendChild(panes);

  if (strategy.sourcingStrategy) {
    card.appendChild(h("div", { style: "margin-top:14px;padding:10px;border-radius:6px;background:var(--panel2);border:1px solid var(--border)" },
      h("div", { class: "muted", style: "font-size:11px;text-transform:uppercase;margin-bottom:4px" }, "Sourcing strategy narrative"),
      h("div", {}, strategy.sourcingStrategy),
    ));
  }
  return card;
}
const PORTALS_UI = ["linkedin", "naukri", "instahyre"];

function searchStringRow(s, roleId) {
  const ta = h("textarea", { rows: 2 }, s.query);
  return h("div", { style: "border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--panel2)" },
    h("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px" },
      h("div", {}, h("span", { class: "badge" }, s.portal), " ",
        h("span", { class: `badge ${s.status === "approved" ? "good" : "warn"}` }, s.status)),
      h("div", {},
        h("button", { class: "ghost", onclick: async () => { await update("searchStrings", s.id, { query: ta.value, status: "approved" }); toast("Approved"); route(); } }, "Save & approve"),
        " ",
        h("button", { onclick: async () => {
          const text = ta.value || "";
          await update("searchStrings", s.id, { query: text, status: "approved" });
          try {
            await navigator.clipboard.writeText(text);
            toast("Boolean copied to clipboard. Paste it into the portal's search bar.");
          } catch {
            // Fallback: select text in textarea so user can copy manually.
            ta.focus(); ta.select();
            toast("Select-and-copy: textarea is highlighted (clipboard API blocked).");
          }
        } }, "Copy search"),
        " ",
        h("button", { class: "danger", onclick: async () => { await remove("searchStrings", s.id); route(); } }, "Delete"),
      ),
    ),
    ta,
  );
}

// ---------- SEARCHES ----------
async function renderSearches() {
  const [searches, queue, roles] = await Promise.all([getAll("searches", []), getAll("queue", []), getAll("roles", [])]);
  const roleName = (id) => roles.find(r => r.id === id)?.title || "(deleted)";
  app.append(
    h("h1", {}, "Searches"),
    h("p", { class: "sub" }, "Queued and completed scrape jobs. The extension runs them in your logged-in browser, one at a time."),
    h("div", { class: "card", style: "padding:0" },
      h("h2", { style: "padding:14px 14px 0" }, "Queue"),
      queue.length === 0
        ? h("div", { class: "empty" }, "Nothing queued.")
        : table(["Role", "Portal", "Query", "Status", ""], queue.slice().reverse().map(j => [
            roleName(j.roleId),
            h("span", { class: "badge" }, j.portal),
            h("code", { style: "font-size:11px" }, j.query.slice(0, 70) + (j.query.length > 70 ? "…" : "")),
            h("span", { class: `badge ${j.status === "done" ? "good" : j.status === "error" ? "bad" : "warn"}` }, j.status),
            h("button", { class: "ghost", onclick: async () => { await remove("queue", j.id); route(); } }, "Remove"),
          ])),
    ),
    h("div", { class: "card", style: "padding:0;margin-top:16px" },
      h("h2", { style: "padding:14px 14px 0" }, "History"),
      searches.length === 0
        ? h("div", { class: "empty" }, "No runs yet.")
        : table(["Role", "Portal", "Status", "Count", "Started", "Error"], searches.slice().reverse().map(s => [
            roleName(s.roleId),
            h("span", { class: "badge" }, s.portal),
            h("span", { class: `badge ${s.status === "done" ? "good" : s.status === "error" ? "bad" : "warn"}` }, s.status),
            String(s.count || 0),
            new Date(s.startedAt).toLocaleString(),
            s.error || "",
          ])),
    ),
  );
}

// ---------- CANDIDATES ----------
async function renderCandidates() {
  let [cands, roles] = await Promise.all([getAll("candidates", []), getAll("roles", [])]);
  const roleName = (id) => roles.find(r => r.id === id)?.title || "(any)";

  const filterRole = h("select", {}, h("option", { value: "" }, "All roles"), ...roles.map(r => h("option", { value: r.id }, r.title)));
  const filterPortal = h("select", {}, ...["", "linkedin", "naukri", "instahyre"].map(p => h("option", { value: p }, p || "All portals")));
  const minScore = h("input", { type: "number", value: 0, min: 0, max: 100, style: "max-width:90px" });
  const search = h("input", { placeholder: "Search name/company/headline" });
  const onlyShortlisted = h("input", { type: "checkbox" });

  const tableWrap = h("div", { class: "card", style: "padding:0" });
  const chatLog = h("div", { style: "max-height:240px;overflow:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:10px" });
  const chatInput = h("input", { placeholder: "e.g. Shortlist anyone with Python and 5+ yrs at a fintech" });

  function getFiltered() {
    let f = cands.slice();
    if (filterRole.value) f = f.filter(c => c.roleId === filterRole.value);
    if (filterPortal.value) f = f.filter(c => c.portal === filterPortal.value);
    const ms = Number(minScore.value) || 0;
    if (ms) f = f.filter(c => (c.score || 0) >= ms);
    if (onlyShortlisted.checked) f = f.filter(c => c.shortlisted);
    if (search.value.trim()) {
      const q = search.value.toLowerCase();
      f = f.filter(c => (c.name + " " + (c.companies||[]).join(" ") + " " + (c.company||"") + " " + c.headline).toLowerCase().includes(q));
    }
    f.sort((a, b) => (b.score || 0) - (a.score || 0));
    return f;
  }

  function render() {
    const f = getFiltered();
    tableWrap.innerHTML = "";
    tableWrap.appendChild(
      f.length === 0
        ? h("div", { class: "empty" }, "No candidates match.")
        : table(["★", "Score", "Bucket", "Name", "Headline", "Company", "Availability", "Portal", "Role", "Profile", "Resume", "Rationale"], f.map(c => {
            const star = h("input", { type: "checkbox" });
            star.checked = !!c.shortlisted;
            star.onchange = async () => {
              await update("candidates", c.id, { shortlisted: star.checked });
              c.shortlisted = star.checked;
            };
            const bucketCls = c.bucket === "auto" ? "good" : c.bucket === "review" ? "warn" : c.bucket === "reject" ? "bad" : "";
            const av = c.availability || (c.openToWork ? "open_to_work" : "");
            const avLabel = av === "open_to_work" ? "Open to work" : av === "hiring" ? "Hiring" : av === "active" ? "Active" : "—";
            const avCls = av === "open_to_work" ? "good" : av === "hiring" ? "warn" : "";
            return [
              star,
              h("span", { class: "score" }, String(c.score ?? "—")),
              c.bucket ? h("span", { class: `badge ${bucketCls}` }, c.bucket) : "",
              c.name || "",
              c.headline || "",
              (Array.isArray(c.companies) && c.companies.length ? c.companies.join(", ") : (c.company || "—")),
              h("span", { class: `badge ${avCls}` }, avLabel),
              h("span", { class: "badge" }, c.portal),
              roleName(c.roleId),
              c.profileUrl ? h("a", { class: "link", href: c.profileUrl, target: "_blank" }, "Open") : "",
              c.resumeAttemptedAt
                ? h("span", { class: `badge ${c.resumeOk ? "good" : "bad"}` }, c.resumeOk ? "downloaded" : "failed")
                : h("span", { class: "muted" }, "—"),
              h("span", { class: "muted", style: "font-size:12px" }, c.rationale || c.scoreError || ""),
            ];
          }))
    );
  }
  [filterRole, filterPortal, minScore, search, onlyShortlisted].forEach(el => el.addEventListener("input", render));
  onlyShortlisted.addEventListener("change", render);

  function appendChat(role, text) {
    chatLog.appendChild(h("div", {
      style: `align-self:${role === "you" ? "flex-end" : "flex-start"};max-width:80%;padding:8px 12px;border-radius:10px;background:${role === "you" ? "var(--primary)" : "var(--panel2)"};color:${role === "you" ? "#fff" : "var(--text)"};font-size:13px;white-space:pre-wrap`,
    }, text));
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  async function sendChat() {
    const msg = chatInput.value.trim(); if (!msg) return;
    chatInput.value = ""; appendChat("you", msg);
    const role = filterRole.value ? roles.find(r => r.id === filterRole.value) : null;
    const scope = filterRole.value ? cands.filter(c => c.roleId === filterRole.value) : cands;
    appendChat("ai", "…");
    try {
      const res = await chatShortlist({ message: msg, candidates: scope, role });
      chatLog.lastChild.remove();
      if (res.action === "shortlist" || res.action === "unshortlist") {
        const flag = res.action === "shortlist";
        for (const id of (res.ids || [])) {
          await update("candidates", id, { shortlisted: flag });
          const c = cands.find(x => x.id === id); if (c) c.shortlisted = flag;
        }
      }
      appendChat("ai", res.reply || "Done.");
      render();
    } catch (e) {
      chatLog.lastChild.remove();
      appendChat("ai", "Error: " + e.message);
    }
  }
  chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  async function bulkOpenLinkedIn() {
    const f = getFiltered().filter(c => c.shortlisted && c.portal === "linkedin" && c.profileUrl);
    if (!f.length) return toast("No shortlisted LinkedIn profiles in current filter");
    if (!confirm(`Open ${f.length} LinkedIn profile(s) in background tabs? Click "Save to Project" on each manually.`)) return;
    chrome.runtime.sendMessage({ type: "bulkOpen", urls: f.map(c => c.profileUrl) });
    toast("Opening tabs…");
  }
  async function downloadResumes() {
    const f = getFiltered().filter(c => c.shortlisted);
    if (!f.length) return toast("No shortlisted candidates in current filter");
    if (!confirm(`Try to download ${f.length} resume(s) into Downloads/sourcing-agent/{role}/? Requires recruiter seats on each portal.`)) return;
    toast(`Starting ${f.length} downloads…`);
    chrome.runtime.sendMessage({ type: "downloadResumes", ids: f.map(c => c.id) }, (resp) => {
      const ok = resp?.results?.filter(r => r.ok).length || 0;
      toast(`Done. ${ok}/${f.length} succeeded. Reload to refresh status.`, 5000);
    });
  }

  app.append(
    h("h1", {}, "Candidates"),
    h("div", { class: "card" },
      h("h2", {}, "Chat to shortlist"),
      h("p", { class: "muted", style: "margin-top:-4px;font-size:12px" }, "Tip: filter by role first, then ask the AI to shortlist subsets."),
      chatLog,
      h("div", { style: "display:flex;gap:8px" },
        chatInput,
        h("button", { onclick: sendChat }, "Send"),
      ),
    ),
    h("div", { class: "card" },
      h("div", { class: "row" },
        field("Role", filterRole),
        field("Portal", filterPortal),
        field("Min score", minScore),
        field("Search", search),
      ),
      h("div", { style: "margin-top:8px;display:flex;align-items:center;gap:8px" },
        onlyShortlisted, h("span", {}, "Only shortlisted"),
      ),
      h("div", { class: "btnrow" },
        h("button", { onclick: bulkOpenLinkedIn }, "Open shortlisted on LinkedIn"),
        h("button", { onclick: downloadResumes }, "Download resumes (shortlisted)"),
        h("button", { class: "ghost", onclick: () => exportCSV(getFiltered(), roles) }, "Export CSV"),
        h("button", { class: "danger", onclick: async () => { if (confirm("Delete ALL candidates?")) { await setAll("candidates", []); route(); } } }, "Clear all"),
      ),
    ),
    tableWrap,
  );
  render();
}

function exportCSV(cands, roles) {
  const headers = ["score","name","headline","companies","availability","location","portal","role","profileUrl","matchedSkills","gaps","rationale"];
  const rows = cands.map(c => [
    c.score ?? "", c.name, c.headline, (Array.isArray(c.companies) && c.companies.length ? c.companies.join("|") : (c.company||"")), c.availability || (c.openToWork ? "open_to_work" : ""), c.location, c.portal,
    roles.find(r => r.id === c.roleId)?.title || "",
    c.profileUrl, (c.matchedSkills||[]).join("|"), (c.gaps||[]).join("|"), c.rationale || "",
  ]);
  const csv = [headers, ...rows].map(r => r.map(x => `"${String(x ?? "").replace(/"/g,'""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  chrome.downloads.download({ url, filename: "candidates.csv" });
}

// ---------- COMPANY LISTS ----------
async function renderCompanies() {
  const lists = await getAll("companyLists", []);
  app.append(
    h("h1", {}, "Company lists"),
    h("p", { class: "sub" }, "Edit categories used in search strings. Focus categories (★) are pre-selected on new roles."),
    h("button", { onclick: async () => { await append("companyLists", { id: uid(), name: "New category", isFocus: false, sortOrder: 99, companies: [] }); route(); } }, "+ Add category"),
    h("div", { style: "margin-top:16px;display:flex;flex-direction:column;gap:12px" },
      ...lists.sort((a,b)=>a.sortOrder-b.sortOrder).map(l => {
        const name = h("input", { value: l.name });
        const focus = h("input", { type: "checkbox" }); focus.checked = l.isFocus;
        const ta = h("textarea", { rows: 4 }, l.companies.join(", "));
        return h("div", { class: "card" },
          h("div", { class: "row" },
            field("Name", name),
            h("div", {}, h("label", {}, "Focus category"), h("div", { style:"padding-top:6px" }, focus, " ", h("span", { class:"muted" }, "Pre-selected on new roles"))),
          ),
          field("Companies (comma separated)", ta),
          h("div", { class: "btnrow" },
            h("button", { onclick: async () => {
              await update("companyLists", l.id, { name: name.value.trim(), isFocus: focus.checked, companies: csv(ta.value) });
              toast("Saved");
            } }, "Save"),
            h("button", { class: "danger", onclick: async () => { if (confirm("Delete category?")) { await remove("companyLists", l.id); route(); } } }, "Delete"),
          ),
        );
      }),
    ),
  );
}

// ---------- SETTINGS ----------
async function renderSettings() {
  const s = await getSettings();
  const provider = h("select", {},
    ...Object.entries(PROVIDERS).map(([id, p]) => h("option", { value: id }, p.label)),
  );
  provider.value = s.aiProvider || "gemini";

  const model = h("select", {});
  const customModel = h("input", { placeholder: "Or type a custom model id", value: "" });
  const key = h("input", { type: "password", value: s.aiKey || "", placeholder: "Paste API key" });
  const keyLink = h("a", { class: "link", target: "_blank", href: PROVIDERS[provider.value].keyUrl }, "Get a key");

  function syncProvider() {
    const p = PROVIDERS[provider.value];
    model.innerHTML = "";
    p.models.forEach(m => model.appendChild(h("option", { value: m }, m)));
    const current = s.aiProvider === provider.value ? (s.aiModel || p.defaultModel) : p.defaultModel;
    if (!p.models.includes(current)) {
      model.appendChild(h("option", { value: current }, current));
    }
    model.value = current;
    keyLink.href = p.keyUrl;
    keyLink.textContent = `Get a ${p.label} key`;
  }
  syncProvider();
  provider.addEventListener("change", syncProvider);

  app.append(
    h("h1", {}, "Settings"),
    h("p", { class: "sub" }, "All data stays in this Chrome profile (chrome.storage.local). Nothing is sent to any server except your chosen AI provider."),
    h("div", { class: "card" },
      h("h2", {}, "AI provider"),
      h("p", { class: "muted" }, "Pick a provider, paste your own API key. ", keyLink, "."),
      h("div", { class: "row" },
        field("Provider", provider),
        field("Model", model),
      ),
      field("Custom model id (optional, overrides above)", customModel),
      field("API key", key),
      h("div", { class: "btnrow" },
        h("button", { onclick: async () => {
          const chosenModel = customModel.value.trim() || model.value;
          await saveSettings({ aiProvider: provider.value, aiKey: key.value.trim(), aiModel: chosenModel });
          toast("Saved");
        } }, "Save"),
      ),
    ),
    h("div", { class: "card" },
      h("h2", {}, "Device"),
      h("p", {}, "Device ID: ", h("code", {}, s.deviceId)),
    ),
    h("div", { class: "card" },
      h("h2", {}, "Backup / restore"),
      h("div", { class: "btnrow" },
        h("button", { class: "ghost", onclick: exportAll }, "Export all data (JSON)"),
        h("button", { class: "ghost", onclick: () => document.getElementById("imp").click() }, "Import"),
        h("input", { id: "imp", type: "file", accept: "application/json", style: "display:none", onchange: importAll }),
        h("button", { class: "danger", onclick: async () => {
          if (confirm("Wipe ALL local data?")) { await chrome.storage.local.clear(); toast("Cleared. Reload."); }
        } }, "Wipe everything"),
      ),
    ),
  );
}

async function exportAll() {
  const all = await chrome.storage.local.get(null);
  const url = URL.createObjectURL(new Blob([JSON.stringify(all, null, 2)], { type: "application/json" }));
  chrome.downloads.download({ url, filename: "sourcing-agent-backup.json" });
}
async function importAll(e) {
  const f = e.target.files[0]; if (!f) return;
  const data = JSON.parse(await f.text());
  await chrome.storage.local.set(data);
  toast("Imported. Reload to see changes."); route();
}

// ---------- helpers ----------
const csv = (v) => v.split(",").map(x => x.trim()).filter(Boolean);
const field = (label, ctrl) => h("div", {}, h("label", {}, label), ctrl);
const kpi = (l, v) => h("div", { class: "card" }, h("div", { class: "l" }, l), h("div", { class: "v" }, String(v)));
const table = (cols, rows) => {
  const t = h("table", {}, h("thead", {}, h("tr", {}, ...cols.map(c => h("th", {}, c)))),
    h("tbody", {}, ...rows.map(r => h("tr", {}, ...r.map(c => h("td", {}, typeof c === "string" || typeof c === "number" ? String(c) : c))))));
  return t;
};

// ---------- Live agent panel ----------
let _agentListener = null;
function agentPanel() {
  const log = h("div", { id: "agentLog", style: "max-height:160px;overflow:auto;font-size:12px;font-family:monospace;background:var(--panel2);padding:8px;border-radius:6px" }, "Agent idle.");
  const candWrap = h("div", { id: "agentCands", style: "margin-top:10px;display:flex;flex-direction:column;gap:6px;max-height:420px;overflow:auto" });
  const status = h("div", { id: "agentStatus", class: "muted", style: "font-size:12px;margin-bottom:6px" }, "");
  return h("div", { class: "card" },
    h("h2", {}, "Agent live progress"),
    status, log, candWrap,
  );
}
function startAgentPanel(roleId) {
  const log = document.getElementById("agentLog");
  const candWrap = document.getElementById("agentCands");
  const status = document.getElementById("agentStatus");
  if (!log) return;
  log.innerHTML = ""; candWrap.innerHTML = ""; status.textContent = "Starting…";
  if (_agentListener) chrome.runtime.onMessage.removeListener(_agentListener);
  _agentListener = (msg) => {
    if (msg?.type === "agentProgress" && msg.state) {
      status.textContent = `Processed ${msg.state.processed}/${msg.state.total} • ${msg.state.status || ""}`;
      const lines = (msg.state.log || []).map(l => `[${new Date(l.t).toLocaleTimeString()}] ${l.msg}`).join("\n");
      log.textContent = lines;
      log.scrollTop = log.scrollHeight;
    }
    if (msg?.type === "agentCandidate" && msg.candidate && msg.candidate.roleId === roleId) {
      const c = msg.candidate;
      const bucketCls = c.bucket === "auto" ? "good" : c.bucket === "review" ? "warn" : "bad";
      const row = h("div", { style: "border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--panel2)" },
        h("div", { style: "display:flex;justify-content:space-between;gap:8px;align-items:center" },
          h("div", {},
            h("strong", {}, c.name || "(no name)"), " ",
            h("span", { class: `badge ${bucketCls}` }, `${c.score ?? "?"} • ${c.bucket || "?"}`),
          ),
          c.profileUrl ? h("a", { class: "link", href: c.profileUrl, target: "_blank" }, "Profile") : "",
        ),
        h("div", { class: "muted", style: "font-size:12px;margin-top:4px" }, `${c.headline || ""} ${c.company ? "• " + c.company : ""} ${c.location ? "• " + c.location : ""}`),
        c.subscores ? h("div", { class: "muted", style: "font-size:11px;margin-top:4px" },
          `JD ${c.subscores.resumeJdMatch ?? "?"} · Loc ${c.subscores.locationMatch ?? "?"} · Div ${c.subscores.diversity ?? 0}` +
          (c.weightsUsed ? ` (weights ${c.weightsUsed.resumeJd}/${c.weightsUsed.location}/${c.weightsUsed.diversity})` : "")
        ) : null,
        c.rationale ? h("div", { style: "font-size:12px;margin-top:4px" }, c.rationale) : null,
        c.titleFit ? h("div", { class: "muted", style: "font-size:11px;margin-top:2px" }, "Title fit: " + c.titleFit) : null,
        c.companyFit ? h("div", { class: "muted", style: "font-size:11px" }, "Company fit: " + c.companyFit) : null,
        c.locationFit ? h("div", { class: "muted", style: "font-size:11px" }, "Location fit: " + c.locationFit) : null,
        c.diversityNote ? h("div", { class: "muted", style: "font-size:11px" }, "Diversity: " + c.diversityNote) : null,
        (c.matchedSkills?.length) ? h("div", { class: "muted", style: "font-size:11px;margin-top:4px" }, "Matched: " + c.matchedSkills.join(", ")) : null,
        (c.gaps?.length) ? h("div", { class: "muted", style: "font-size:11px" }, "Gaps: " + c.gaps.join(", ")) : null,
      );
      candWrap.prepend(row);
    }
  };
  chrome.runtime.onMessage.addListener(_agentListener);
}

if (!location.hash) location.hash = "#/roles";
route();
