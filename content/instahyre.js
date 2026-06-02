// Instahyre scraper (recruiter side).
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (location.pathname.includes("/login")) { chrome.runtime.sendMessage({ type: "captcha" }); return; }
  for (let i = 0; i < 20; i++) {
    if (document.querySelector(".candidate-card, .candidate-row, [class*=Candidate]")) break;
    await sleep(700);
  }
  for (let i = 0; i < 3; i++) { window.scrollTo(0, document.body.scrollHeight); await sleep(700); }
  const text = (el, sel) => el.querySelector(sel)?.textContent?.trim() || "";
  const cards = Array.from(document.querySelectorAll(".candidate-card, .candidate-row, [class*=CandidateCard]"));
  const out = [];
  for (const c of cards) {
    const name = text(c, ".candidate-name, h3, h4, [class*=name]");
    const headline = text(c, ".candidate-title, .designation, [class*=title]");
    const company = text(c, ".candidate-company, [class*=company]");
    const locationText = text(c, "[class*=location]");
    const snippet = text(c, "[class*=summary], [class*=skills]");
    const link = c.querySelector("a")?.href || "";
    if (!name) continue;
    out.push({ name, headline, company, location: locationText, snippet, profileUrl: link });
    if (out.length >= 25) break;
  }
  chrome.runtime.sendMessage({ type: "candidates", payload: out });
})();
