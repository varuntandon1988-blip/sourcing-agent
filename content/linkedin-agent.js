// Comet-style agent step injected into the LinkedIn tab to scrape one results page.
// Returns: { isRecruiter, candidates: [...], hasNext, totalGuess }
// Selectors are best-effort and cover both LinkedIn People search and Recruiter.
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const text = (el, sel) => clean(el?.querySelector?.(sel)?.textContent);

  // Captcha / authwall detection
  if (location.href.includes("/checkpoint/") || location.href.includes("/authwall")) {
    return { error: "captcha", isRecruiter: false, candidates: [], hasNext: false };
  }

  const isRecruiter = /linkedin\.com\/(talent|recruiter)/i.test(location.href);

  // Wait for results to render
  for (let i = 0; i < 25; i++) {
    if (document.querySelector(
      'li.reusable-search__result-container, div.entity-result, [data-chameleon-result-urn], li.profile-list-item, article[data-test-profile-card], div.profile-card'
    )) break;
    await sleep(500);
  }

  // Auto-scroll to load lazy items
  for (let i = 0; i < 8; i++) {
    window.scrollBy(0, 1400);
    await sleep(500);
  }
  window.scrollTo(0, 0);
  await sleep(300);

  // Card selectors across surfaces
  const cardSelectors = [
    'li.reusable-search__result-container',
    'div.entity-result',
    '[data-chameleon-result-urn]',
    'li.profile-list-item',
    'li[data-test-search-result]',
    'article[data-test-profile-card]',
    'div.profile-card',
    'div[data-test-id*="profile"]',
  ];
  let cards = [];
  for (const sel of cardSelectors) {
    const found = Array.from(document.querySelectorAll(sel));
    if (found.length > cards.length) cards = found;
  }
  if (!cards.length) {
    const anchors = Array.from(document.querySelectorAll('a[href*="/talent/profile/"], a[href*="/in/"]'));
    const seen = new Set();
    cards = anchors.map(a => a.closest('li,article,div')).filter(el => el && !seen.has(el) && seen.add(el));
  }

  const out = [];
  const seen = new Set();
  for (const c of cards) {
    const link = c.querySelector('a[href*="/talent/profile/"]') || c.querySelector('a[href*="/in/"]');
    if (!link) continue;
    const profileUrl = link.href.split("?")[0];
    if (seen.has(profileUrl)) continue;
    seen.add(profileUrl);
    let name = clean(link.innerText).split("\n")[0].replace(/View .*?'s profile/i, "").trim();
    if (!name) name = text(c, '[data-test-search-result-name]') || text(c, '.artdeco-entity-lockup__title') || text(c, '.entity-result__title-text');
    const headline = text(c, '[data-test-search-result-headline]') || text(c, '.artdeco-entity-lockup__subtitle') || text(c, '.entity-result__primary-subtitle') || text(c, '.t-14.t-black.t-normal');
    const location = text(c, '[data-test-search-result-location]') || text(c, '.artdeco-entity-lockup__caption') || text(c, '.entity-result__secondary-subtitle');
    const company = text(c, '[data-test-search-result-company]') || (headline.split(/ at | @ /i)[1] || "").trim();
    const snippet = text(c, '.entity-result__summary') || text(c, '.entity-result__content-summary') || text(c, '.profile-card__highlights');
    const cardText = (c.innerText || "").toLowerCase();
    const openToWork = /open to work/i.test(cardText) || !!c.querySelector('[aria-label*="Open to work" i]');
    const hiring = /\bhiring\b/i.test(cardText) || !!c.querySelector('[aria-label*="hiring" i]');
    const availability = openToWork ? "open_to_work" : hiring ? "hiring" : "active";
    if (!name) continue;
    out.push({ name, headline, company, location, snippet, profileUrl, availability, openToWork });
  }

  // Detect if a "Next" page exists
  const nextBtn = document.querySelector('button[aria-label="Next"]:not([disabled])')
    || document.querySelector('button.artdeco-pagination__button--next:not([disabled])')
    || document.querySelector('a[aria-label="Next"]');
  const hasNext = !!nextBtn;

  return { isRecruiter, candidates: out, hasNext };
})();
