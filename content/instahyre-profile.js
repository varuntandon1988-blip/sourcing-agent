// Scrape an open Instahyre candidate profile page.
// Returns { name, headline, company, companies[], location, experienceText, skillsList[], availability, profileUrl }.
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const text = (sel, root = document) => clean(root.querySelector?.(sel)?.textContent || "");

  for (let i = 0; i < 20; i++) {
    if (document.querySelector('.profile-name, .candidate-name, h1, h2, [class*="Profile" i] h1, [class*="Candidate" i] h2')) break;
    await sleep(400);
  }
  for (let i = 0; i < 5; i++) { window.scrollBy(0, 1200); await sleep(400); }
  window.scrollTo(0, 0); await sleep(200);

  const name =
    text('.profile-name, .candidate-name, h1, h2.title') ||
    text('[class*="name" i]');
  const headline =
    text('.designation, .current-designation, [class*="designation" i], [class*="title" i]');
  const location =
    text('.location, [class*="location" i], [class*="Location" i]');

  const companies = [];
  const seen = new Set();
  const pushCo = (s) => {
    const v = clean(s).replace(/\s*\(.*?\)\s*$/, "");
    if (!v || v.length < 2 || v.length > 80) return;
    if (/^(present|current|ago|year|month|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(v)) return;
    if (seen.has(v.toLowerCase())) return;
    seen.add(v.toLowerCase()); companies.push(v);
  };
  const expRoot = document.querySelector('.experience, [class*="experience" i], [id*="experience" i], [class*="Experience" i]') || document;
  expRoot.querySelectorAll('.org, .company, [class*="company" i], [class*="Company" i]').forEach((el) => pushCo(el.textContent));
  expRoot.querySelectorAll('li, .exp-row, .experience-row, .row').forEach((el) => {
    const t = clean(el.textContent);
    const m = t.match(/(?:@|\bat\b|—|-)\s*([A-Z][A-Za-z0-9&., ]{1,60})/);
    if (m) pushCo(m[1]);
  });
  const company = companies[0] || text('.current-company, [class*="currentCompany" i]');

  const skillsList = Array.from(document.querySelectorAll('.skill, .keySkill, [class*="skill" i] li, [class*="Skill" i] span, .tag, .chip'))
    .map((el) => clean(el.textContent)).filter((s) => s && s.length > 1 && s.length < 50).slice(0, 40);

  const bodyTxt = clean(document.body.innerText).slice(0, 4000).toLowerCase();
  let availability = "active";
  if (/active\s+today|active\s+a\s+day\s+ago|active\s+\d+\s+day/.test(bodyTxt)) availability = "active";
  if (/open\s+to\s+(work|opportunit)|looking\s+for\s+(a\s+)?(new|change)/.test(bodyTxt)) availability = "open-to-work";
  if (/notice\s+period\s*:?\s*(serving|0|immediate|15)/.test(bodyTxt)) availability = "open-to-work";

  const experienceText =
    clean((expRoot.innerText || "")).slice(0, 4000) ||
    clean(document.body.innerText).slice(0, 3000);

  return {
    name, headline, company, companies, location, skillsList,
    availability, openToWork: availability === "open-to-work",
    experienceText, profileUrl: window.location.href.split("#")[0],
  };
})();
