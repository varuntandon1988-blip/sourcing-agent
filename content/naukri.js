// Naukri results scraper.
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (document.title.toLowerCase().includes("captcha")) { chrome.runtime.sendMessage({ type: "captcha" }); return; }
  for (let i = 0; i < 20; i++) {
    if (document.querySelector(".srp-jobtuple-wrapper, article.jobTuple, .resultsList")) break;
    await sleep(700);
  }
  for (let i = 0; i < 3; i++) { window.scrollTo(0, document.body.scrollHeight); await sleep(700); }
  const text = (el, sel) => el.querySelector(sel)?.textContent?.trim() || "";
  const cards = Array.from(document.querySelectorAll(".srp-jobtuple-wrapper, article.jobTuple"));
  const out = [];
  for (const c of cards) {
    const name = text(c, ".title, a.title");
    const company = text(c, ".comp-name, .companyInfo .subTitle, a.subTitle");
    const headline = text(c, ".job-desc, .job-description");
    const locationText = text(c, ".locWdth, .loc, .location");
    const link = c.querySelector("a.title")?.href || "";
    if (!name) continue;
    out.push({ name, headline: name, company, location: locationText, snippet: headline, profileUrl: link });
    if (out.length >= 25) break;
  }
  chrome.runtime.sendMessage({ type: "candidates", payload: out });
})();
