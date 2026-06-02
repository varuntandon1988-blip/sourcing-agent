// Naukri Resdex / RMS recruiter scraper. Returns rich candidate cards from the
// active search results page. Extracts: name, currentTitle, currentCompany,
// previousTitle, previousCompany, location, prefLocations, education, college,
// expYears, expMonths, ctcLacs, keySkills, mayAlsoKnow, activelyApplying,
// lastModified, lastActive, profileUrl.

// Pure parser functions are defined outside the IIFE so they can be imported
// in Node test environments via the conditional module.exports at the bottom.

const _clean = (s) => (s || "").replace(/\s+/g, " ").trim();

function parseExperience(card) {
  const t = _clean(card.textContent);
  // Pattern "14y 0m" or "13 yrs 6 mo"
  let m = t.match(/(\d{1,2})\s*y(?:rs?)?\s*(\d{1,2})?\s*m?/i);
  if (m) return { years: +m[1], months: +(m[2] || 0) };
  m = t.match(/(\d{1,2})\s*years?/i);
  if (m) return { years: +m[1], months: 0 };
  return { years: null, months: null };
}

function parseCTC(card) {
  const t = _clean(card.textContent);
  // ₹46.37 Lacs / Rs 12 Lacs / 12.5 LPA
  let m = t.match(/(?:₹|Rs\.?)\s*([\d.]+)\s*(?:Lacs|Lakhs|L|LPA)/i);
  if (m) return parseFloat(m[1]);
  m = t.match(/([\d.]+)\s*(?:Lacs|Lakhs|LPA)/i);
  if (m) return parseFloat(m[1]);
  return null;
}

function splitCurrent(s) {
  // "Senior Data Engineer at PepsiCo" -> { title, company }
  if (!s) return { title: "", company: "" };
  const m = s.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (m) return { title: _clean(m[1]), company: _clean(m[2]) };
  return { title: s, company: "" };
}

function extractCollege(eduText) {
  if (!eduText) return "";
  // "Bachelor of Technology / B.Tech ... <College Name> 2011"
  const fromMatch = eduText.match(/from\s+([A-Z][A-Za-z .,&()\-]{3,80})/);
  if (fromMatch) return _clean(fromMatch[1]);
  const slash = eduText.split("/").pop();
  if (slash) return _clean(slash.replace(/\b\d{4}\b/g, ""));
  return _clean(eduText.replace(/\b\d{4}\b/g, ""));
}

(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = _clean;

  // Look up a value next to a label (e.g. "Current", "Previous", "Education").
  function valByLabel(card, label) {
    const rx = new RegExp("^" + label + "\\b", "i");
    const nodes = Array.from(card.querySelectorAll("*"));
    for (const n of nodes) {
      const t = clean(n.textContent);
      if (!rx.test(t)) continue;
      // Find sibling/next cell value
      const sib = n.nextElementSibling;
      if (sib) {
        const v = clean(sib.textContent);
        if (v && !rx.test(v)) return v;
      }
      // Parent row pattern: label + value side-by-side
      const parent = n.parentElement;
      if (parent) {
        const txt = clean(parent.textContent).replace(rx, "").replace(/^[:\-\s]+/, "");
        if (txt) return txt;
      }
    }
    return "";
  }

  function extractKeySkills(card) {
    const out = new Set();
    const nodes = Array.from(card.querySelectorAll(
      '.skill, .keySkill, [class*="skill" i] li, [class*="Skill" i] span, [class*="chip" i], [class*="tag" i]'
    ));
    for (const n of nodes) {
      const v = clean(n.textContent);
      if (!v) continue;
      if (v.length > 50) continue;
      if (/may also know|key skills|more$/i.test(v)) continue;
      out.add(v);
    }
    // Fallback: split row beginning with "Key skills"
    if (!out.size) {
      const rx = /Key skills\s*:?\s*([\s\S]{1,400}?)(?:May also know|$)/i;
      const m = clean(card.textContent).match(rx);
      if (m) m[1].split(/\s*\|\s*|,\s*/).forEach((s) => { const v = clean(s); if (v) out.add(v); });
    }
    return Array.from(out).slice(0, 30);
  }

  function extractMayAlsoKnow(card) {
    const txt = clean(card.textContent);
    const m = txt.match(/May also know\s*:?\s*([\s\S]{1,200}?)\s*(?:more|$)/i);
    if (!m) return [];
    return m[1].split(/\s*\|\s*|,\s*/).map(clean).filter(Boolean).slice(0, 15);
  }

  function looksLikeName(s) {
    const t = clean(s).replace(/\b(hidden gem|actively applying|open to work)\b/ig, "").trim();
    if (!t || t.length < 3 || t.length > 80) return false;
    if (/^(select all|add to|set reminder|view similar|comments|save|more|key skills|education)$/i.test(t)) return false;
    return /^[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,4}$/.test(t);
  }

  function closestCandidateCard(el) {
    let cur = el;
    let best = null;
    while (cur && cur !== document.body) {
      const txt = clean(cur.textContent || "");
      const rect = cur.getBoundingClientRect?.();
      if (txt.length > 80 && txt.length < 3500 && rect && rect.height > 70) best = cur;
      if (/Key skills|Education|Previous|Current|Pref locations|May also know/i.test(txt) && txt.length < 3500) return cur;
      cur = cur.parentElement;
    }
    return best || el.closest?.('li, article, section, div') || null;
  }

  // Find the "open profile" anchor inside a card. Naukri usually wraps the name
  // in a link that opens a new tab.
  function findProfileLink(card) {
    // Priority 1: any anchor with a real profile href (not javascript:).
    // Include .nameLink which Naukri's current React build uses.
    const cands = Array.from(card.querySelectorAll(
      'a.nameLink, [class*="nameLink" i] a, a[href*="/resdex/profile/"], a[href*="/resdex/cv/"], a[href*="/profile/"], a[href*="/cv/"], a[href*="/candidate"], a[href*="resume"], a[target="_blank"][href*="naukri"], a[href*="resdex"]'
    ));
    for (const a of cands) {
      const h = a.getAttribute("href") || "";
      if (!h || h === "#") continue;
      if (/javascript:/i.test(h)) continue;
      return a;
    }
    // Priority 2: name-area anchor or element, even if href is javascript: — the
    // profile URL may be in data attributes on the link or on the card itself.
    const nameNode = card.querySelector(
      'a.nameLink, [class*="nameLink" i] a, a.title, .candidate-name a, .name a, ' +
      '[class*="Name"] a, h3 a, h4 a, [onclick][class*="name" i], [role="link"][class*="name" i]'
    );
    if (nameNode) return nameNode;
    const anchors = Array.from(card.querySelectorAll('a, [role="link"], [onclick]'));
    return anchors.find((a) => looksLikeName(a.textContent || a.innerText || "")) || null;
  }

  async function scrape() {
    // Scroll to trigger lazy rendering (Naukri renders rows as they enter viewport)
    for (let i = 0; i < 10; i++) { window.scrollBy(0, 1000); await sleep(400); }
    window.scrollTo(0, 0); await sleep(600);

    const cardSelectors = [
      '.candidate-tuple', '.candidateTuple', '.cand-tuple',
      'div[data-test-id*="candidate"]', 'article.candidate',
      '.srp-tuple', 'li.candidateRow', '.result-tuple',
      // Newer Resdex layout
      '[class*="CandidateCard"]', '[class*="candidate-card"]',
      // Older/current Resdex tuple variants seen in recruiter accounts
      '.profile-tuple', '.profileTuple', '.cvTuple', '.resTuple', '.tuple', '[class*="tuple" i]', '[id^="tuple"]',
    ];
    let cards = [];
    let matchedSelector = "";
    for (const sel of cardSelectors) {
      const f = Array.from(document.querySelectorAll(sel));
      if (f.length > cards.length) { cards = f; matchedSelector = sel; }
    }
    if (!cards.length) {
      const anchors = Array.from(document.querySelectorAll('a[href*="/resdex/profile/"], a[href*="/profile/"], a[href*="/cv/"], a[target="_blank"], a, [role="link"], [onclick]'))
        .filter((a) => /profile|resdex|candidate|resume|cv/i.test(a.getAttribute?.("href") || "") || looksLikeName(a.textContent || a.innerText || ""));
      const seen = new Set();
      cards = anchors.map(closestCandidateCard).filter((el) => el && !seen.has(el) && seen.add(el));
      matchedSelector = "(anchor fallback)";
    }

    // Check profileUrl on the first card to confirm extraction works.
    const firstLink = cards[0] ? findProfileLink(cards[0]) : null;
    const firstHref = (() => {
      const h = firstLink?.href || firstLink?.getAttribute?.("href") || "";
      return /^javascript:/i.test(h) ? "" : h;
    })();
    const selectorLog = `[naukri] cardSelector "${matchedSelector}" → ${cards.length} cards, link ${firstHref ? "matched" : "missed"}`;
    console.log(`[sourcing-agent/naukri] cardSelector "${matchedSelector}" → ${cards.length} cards, linkSelector → ${firstHref ? "matched" : "missed/javascript"} (sample: ${firstHref.slice(0, 80) || "—"})`);

    const out = [];
    const seenUrls = new Set();
    cards.slice(0, 60).forEach((card, idx) => {
      // Tag the card so we can re-find it later from the click-driven flow.
      try { card.setAttribute("data-sa-idx", String(idx)); } catch {}

      const link = findProfileLink(card);
      // Collect the raw href from the link element or from data attributes on the
      // link/card. Never strip query params — Naukri profile URLs encode the
      // candidate identity in the query string (e.g. ?resumeId=123456789).
      const rawHref =
        (link?.href && !/^javascript:/i.test(link.href) ? link.href : "") ||
        link?.getAttribute?.("href") ||
        link?.dataset?.href || link?.dataset?.url || link?.dataset?.profileUrl ||
        card.getAttribute?.("data-href") || card.getAttribute?.("data-url") ||
        card.getAttribute?.("data-profile-url") || "";
      const profileUrl = rawHref && !/^javascript:|^#/i.test(rawHref)
        ? new URL(rawHref, location.href).href   // full URL — keep query params
        : "";
      // Dedup by path + the key ID param (avoids false dupes from tracking params).
      const dedupeKey = (() => {
        try {
          const u = new URL(profileUrl);
          return (u.searchParams.get("resumeId") || u.searchParams.get("candidateId") ||
                  u.searchParams.get("resume_id") || u.searchParams.get("id") || u.pathname);
        } catch { return profileUrl; }
      })();
      if (dedupeKey && seenUrls.has(dedupeKey)) return;
      if (dedupeKey) seenUrls.add(dedupeKey);

      const nameRaw = clean(link?.innerText?.split("\n")[0] || "")
        || clean(card.querySelector('.candidate-name, .name, [class*="Name"]')?.textContent || "")
        || clean(card.querySelector('h3, h4')?.textContent || "");
      const name = nameRaw.replace(/\bActively applying\b/i, "").trim();
      if (!name) return;

      const currentRaw = valByLabel(card, "Current") ||
        clean(card.querySelector('.designation, .current-designation, [class*="designation" i]')?.textContent || "");
      const previousRaw = valByLabel(card, "Previous");
      const cur = splitCurrent(currentRaw);
      const prev = splitCurrent(previousRaw);

      const locationGuess =
        clean(card.querySelector('.loc, .location, [class*="location" i], [class*="Location" i]')?.textContent || "") ||
        (clean(card.textContent).match(/\b(Gurugram|Bengaluru|Bangalore|Hyderabad|Pune|Mumbai|Delhi|Noida|Chennai|Kolkata|Ahmedabad|Remote)[A-Za-z ,/]*/) || [])[0] || "";

      const prefLocsRaw = valByLabel(card, "Pref. locations") || valByLabel(card, "Pref locations") || valByLabel(card, "Preferred locations");
      const prefLocations = prefLocsRaw ? prefLocsRaw.split(/\s*,\s*/).map(clean).filter(Boolean) : [];

      const educationRaw = valByLabel(card, "Education");
      const college = extractCollege(educationRaw);

      const exp = parseExperience(card);
      const ctcLacs = parseCTC(card);

      const keySkills = extractKeySkills(card);
      const mayAlsoKnow = extractMayAlsoKnow(card);

      const txt = clean(card.textContent).toLowerCase();
      const activelyApplying = /actively applying/.test(txt);
      let availability = "active";
      if (/active today|active a day ago|active \d+ day/.test(txt)) availability = "active";
      if (/open to work|open to opportunit/.test(txt)) availability = "open-to-work";

      const lastModifiedMatch = clean(card.textContent).match(/Modified\s+([\w\s]+?ago|in last [\w\s]+|today|yesterday)/i);
      const lastActiveMatch = clean(card.textContent).match(/Active\s+([\w\s]+?ago|in last [\w\s]+|today|yesterday)/i);

      out.push({
        name,
        headline: currentRaw || cur.title || "",
        currentTitle: cur.title,
        company: cur.company,
        currentCompany: cur.company,
        previousTitle: prev.title,
        previousCompany: prev.company,
        companies: [cur.company, prev.company].filter(Boolean),
        location: locationGuess,
        prefLocations,
        education: educationRaw,
        college,
        expYears: exp.years,
        expMonths: exp.months,
        ctcLacs,
        keySkills,
        skillsList: keySkills, // back-compat with naukri-profile shape
        mayAlsoKnow,
        snippet: keySkills.slice(0, 10).join(", "),
        activelyApplying,
        availability,
        openToWork: availability === "open-to-work",
        lastModified: lastModifiedMatch ? clean(lastModifiedMatch[1]) : "",
        lastActive: lastActiveMatch ? clean(lastActiveMatch[1]) : "",
        profileUrl,
        cardIndex: idx,
      });
    });
    return { cands: out, selectorLog };
  }
  return scrape();
})();
