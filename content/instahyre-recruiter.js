// Instahyre recruiter search scraper.
// Returns rich candidate cards from the active results page so the background
// agent can either (Option 1) open each profile in a new tab and deep-scrape
// it, or (Option 2) score directly from the brief on the results page.
//
// Each card is tagged with data-sa-idx so the background can re-locate it to
// click the name link (which Instahyre opens in a new tab).
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const text = (el, sel) => clean(el?.querySelector?.(sel)?.textContent || "");
  const all = (el, sel) => Array.from(el?.querySelectorAll?.(sel) || []);

  function parseExperience(s) {
    const t = (s || "").toLowerCase();
    let years = 0, months = 0;
    const y = t.match(/(\d+(?:\.\d+)?)\s*(?:y|yr|yrs|year|years)/);
    const m = t.match(/(\d+)\s*(?:mo|mos|month|months)/);
    if (y) years = parseFloat(y[1]);
    if (m) months = parseInt(m[1], 10);
    return { expYears: years, expMonths: months };
  }
  function parseCTC(s) {
    const t = (s || "").toLowerCase();
    const m = t.match(/(\d+(?:\.\d+)?)\s*(?:l|lpa|lac|lacs|lakh)/);
    if (m) return parseFloat(m[1]);
    const m2 = t.match(/(?:inr|rs\.?|₹)\s*(\d+(?:\.\d+)?)/);
    if (m2) return parseFloat(m2[1]);
    return null;
  }
  function findProfileLink(card) {
    // Priority 1: anchors whose href clearly contains a profile path
    const profilePatterns = [
      'a[href*="/candidate/"]', 'a[href*="/profile/"]', 'a[href*="/c/"]',
      'a[href*="/employer/"]', 'a[href*="/hr/"]', 'a[href*="/view/"]',
      'a[target="_blank"]', '.candidate-name a', '[class*="Name"] a',
      'h3 a', 'h4 a', 'a.title',
    ];
    for (const s of profilePatterns) {
      const a = card.querySelector(s);
      if (a && a.href && !/^javascript:/i.test(a.href) && !/^#/.test(a.getAttribute('href') || '')) return a;
    }
    // Priority 2: any anchor with a real http(s) URL inside the card
    const allAnchors = all(card, 'a');
    const realHrefAnchor = allAnchors.find(a =>
      a.href && /^https?:\/\//i.test(a.href) && !/^javascript:/i.test(a.href));
    if (realHrefAnchor) return realHrefAnchor;
    // Priority 3: first anchor whose visible text looks like a person's name
    for (const a of allAnchors) {
      const t = clean((a.innerText || a.textContent || '').split('\n')[0]);
      if (/^[A-Z][a-zA-Z'.-]+(\s+[A-Z][a-zA-Z'.-]+){1,3}$/.test(t)) return a;
    }
    return null;
  }

  async function scrape() {
    // Lazy-load: scroll
    for (let i = 0; i < 6; i++) { window.scrollBy(0, 1200); await sleep(500); }
    window.scrollTo(0, 0); await sleep(300);

    const cardSelectors = [
      '.candidate-card', '.candidate-row', '[class*="CandidateCard"]',
      '[class*="candidate-tile"]', '[data-test*="candidate"]',
      'div[ng-repeat*="candidate"]', '.candidate', 'li.candidate',
    ];
    let cards = [];
    let matchedSelector = "";
    for (const sel of cardSelectors) {
      const f = Array.from(document.querySelectorAll(sel));
      if (f.length > cards.length) { cards = f; matchedSelector = sel; }
    }
    if (!cards.length) {
      const anchors = Array.from(document.querySelectorAll('a[href*="/candidate/"], a[href*="/profile/"]'));
      const seen = new Set();
      cards = anchors
        .map(a => a.closest('li,article,section,div'))
        .filter(el => el && !seen.has(el) && seen.add(el));
      matchedSelector = "(anchor fallback)";
    }

    const firstLink = cards[0] ? findProfileLink(cards[0]) : null;
    const firstHref = firstLink?.href || "";
    console.log(`[sourcing-agent/instahyre] cardSelector "${matchedSelector}" → ${cards.length} cards, linkSelector → ${firstHref ? "matched" : "missed"} (sample: ${firstHref.slice(0, 80) || "—"})`);

    const out = [];
    const seenUrls = new Set();
    cards.forEach((c, idx) => {
      try { c.setAttribute("data-sa-idx", String(idx)); } catch {}
      const link = findProfileLink(c);
      // Keep full URL including query params — Instahyre may encode the profile
      // identity there. Skip javascript: hrefs.
      const rawHref = (link?.href && !/^javascript:/i.test(link.href) ? link.href : "") ||
        link?.getAttribute?.("href") || link?.dataset?.href || link?.dataset?.url || "";
      const profileUrl = rawHref && !/^javascript:|^#/i.test(rawHref)
        ? new URL(rawHref, location.href).href
        : "";
      if (profileUrl && seenUrls.has(profileUrl)) return;
      if (profileUrl) seenUrls.add(profileUrl);

      // Use innerText + first-line to avoid grabbing entire card text from
      // broad containers that happen to have "name" in their class names.
      const nameEl = c.querySelector('.candidate-name, h3, h4');
      const name = (nameEl ? clean((nameEl.innerText || nameEl.textContent || "").split("\n")[0]) : "") ||
                   clean(link?.innerText?.split("\n")[0]) ||
                   clean(c.querySelector('[class*="candidateName" i], [class*="candidate-name" i]')?.innerText?.split("\n")[0] || "");
      if (!name) return;

      // Use innerText.split('\n')[0] to avoid grabbing all nested text from broad class matches.
      const headlineEl = c.querySelector('.candidate-title, .designation')
        || c.querySelector('[class*="designation" i]')
        || c.querySelector('[class*="title" i]');
      const headline = headlineEl
        ? clean((headlineEl.innerText || headlineEl.textContent || '').split('\n')[0])
        : '';
      const companyEl = c.querySelector('.candidate-company')
        || c.querySelector('[class*="company" i]');
      const company = companyEl
        ? clean((companyEl.innerText || companyEl.textContent || '').split('\n')[0])
        : '';
      const location = text(c, '[class*="location"], [class*="Location"]');
      const cardText = clean(c.innerText || "");
      const expRaw = (cardText.match(/[^.;,\n]*\b\d+(?:\.\d+)?\s*(?:y|yr|yrs|year|years)\b[^.;,\n]*/i) || [""])[0];
      const ctcRaw = (cardText.match(/[^.;,\n]*\b\d+(?:\.\d+)?\s*(?:l|lpa|lac|lacs|lakh)[^.;,\n]*/i) || [""])[0];
      const { expYears, expMonths } = parseExperience(expRaw);
      const ctcLacs = parseCTC(ctcRaw);
      const college = (cardText.match(/(IIT|IIM|NIT|BITS|IIIT|ISB|VIT|SRM|Delhi University|DU|Anna University)[^,;\n]{0,60}/i) || [""])[0].trim();

      // Key skills: chips/tags or comma-separated phrases under skills section
      let keySkills = all(c, '[class*="skill" i], [class*="Skill" i] li, [class*="Skill" i] span, .tag, .chip')
        .map((el) => clean(el.textContent))
        .filter((s) => s && s.length > 1 && s.length < 40);
      keySkills = Array.from(new Set(keySkills)).slice(0, 30);

      const snippet = text(c, '[class*="summary"], [class*="about"], [class*="Description"]') || cardText.slice(0, 400);

      out.push({
        name, headline, currentTitle: headline, currentCompany: company,
        location, expYears, expMonths, ctcLacs,
        keySkills, college, snippet,
        profileUrl, cardIndex: idx,
      });
    });
    return out;
  }
  return scrape();
})();
