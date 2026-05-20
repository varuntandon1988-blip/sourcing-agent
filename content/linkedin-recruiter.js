// Injected on demand into the active LinkedIn Recruiter tab.
// Returns an array of candidates extracted from the current search results page.
// Selectors are best-effort — Recruiter DOM varies by seat (Recruiter, Recruiter Lite, Talent Hub).
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el, sel) => el?.querySelector?.(sel)?.textContent?.trim() || "";
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  async function scrape() {
    // Auto-scroll to load lazy cards
    for (let i = 0; i < 6; i++) {
      window.scrollBy(0, 1200);
      await sleep(700);
    }
    window.scrollTo(0, 0);
    await sleep(400);

    // Try several known card selectors for Recruiter / Recruiter Lite / Talent Hub
    const cardSelectors = [
      'li.profile-list-item',
      'li[data-test-search-result]',
      'div.profile-card',
      'div[data-test-id*="profile"]',
      'li.reusable-search__result-container',
      'div.entity-result',
      'article[data-test-profile-card]',
    ];
    let cards = [];
    for (const sel of cardSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > cards.length) cards = found;
    }
    // Fallback: any element containing a profile link
    if (!cards.length) {
      const anchors = Array.from(document.querySelectorAll('a[href*="/talent/profile/"], a[href*="/in/"]'));
      const seen = new Set();
      cards = anchors.map(a => a.closest('li,article,div')).filter(el => el && !seen.has(el) && seen.add(el));
    }

    const out = [];
    const seenUrls = new Set();
    for (const c of cards) {
      const link =
        c.querySelector('a[href*="/talent/profile/"]') ||
        c.querySelector('a[href*="/in/"]');
      if (!link) continue;
      const profileUrl = link.href.split("?")[0];
      if (seenUrls.has(profileUrl)) continue;
      seenUrls.add(profileUrl);

      // Name: prefer link text, strip junk
      let name = clean(link.innerText).split("\n")[0];
      name = name.replace(/View .*?'s profile/i, "").trim();
      if (!name) name = clean(text(c, '[data-test-search-result-name]')) || clean(text(c, '.artdeco-entity-lockup__title'));

      const headline =
        clean(text(c, '[data-test-search-result-headline]')) ||
        clean(text(c, '.artdeco-entity-lockup__subtitle')) ||
        clean(text(c, '.entity-result__primary-subtitle')) ||
        clean(text(c, '.t-14.t-black.t-normal'));

      const location =
        clean(text(c, '[data-test-search-result-location]')) ||
        clean(text(c, '.artdeco-entity-lockup__caption')) ||
        clean(text(c, '.entity-result__secondary-subtitle'));

      const company =
        clean(text(c, '[data-test-search-result-company]')) ||
        (headline.split(/ at | @ /i)[1] || "").trim();

      const snippet =
        clean(text(c, '.entity-result__summary')) ||
        clean(text(c, '.entity-result__content-summary')) ||
        clean(text(c, '.profile-card__highlights'));

      if (!name) continue;
      out.push({ name, headline, company, location, snippet, profileUrl });
    }
    return out;
  }

  return scrape();
})();
