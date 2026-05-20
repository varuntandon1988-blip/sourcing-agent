// LinkedIn People search scraper. Selectors are best-effort; LinkedIn changes DOM frequently.
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el, sel) => el.querySelector(sel)?.textContent?.trim() || "";

  // Detect captcha / login interruption
  if (location.href.includes("/checkpoint/") || location.href.includes("/authwall") || document.title.toLowerCase().includes("security verification")) {
    chrome.runtime.sendMessage({ type: "captcha" });
    return;
  }

  // Wait for results
  for (let i = 0; i < 20; i++) {
    if (document.querySelector('[data-chameleon-result-urn], li.reusable-search__result-container, .entity-result')) break;
    await sleep(800);
  }
  // Auto-scroll a few pages worth
  for (let i = 0; i < 4; i++) { window.scrollTo(0, document.body.scrollHeight); await sleep(900); }

  const cards = Array.from(document.querySelectorAll("li.reusable-search__result-container, div.entity-result, [data-chameleon-result-urn]"));
  const out = [];
  for (const c of cards) {
    const link = c.querySelector('a[href*="/in/"]');
    const name = link?.innerText?.trim()?.split("\n")[0] || text(c, ".entity-result__title-text") || "";
    const headline = text(c, ".entity-result__primary-subtitle") || text(c, ".t-14.t-black.t-normal");
    const location = text(c, ".entity-result__secondary-subtitle");
    const snippet = text(c, ".entity-result__summary") || text(c, ".entity-result__content-summary");
    const company = (headline.split(/ at | @ /i)[1] || "").trim();
    if (!name) continue;
    out.push({
      name: name.replace(/View .*?'s profile/i, "").trim(),
      headline, company, location, snippet,
      profileUrl: link?.href?.split("?")[0] || "",
    });
    if (out.length >= 25) break;
  }
  chrome.runtime.sendMessage({ type: "candidates", payload: out });
})();
