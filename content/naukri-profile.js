// Scrape an open Naukri Resdex candidate profile page.
// Returns { name, headline, company, companies[], location, experienceText, skillsList[], availability }.
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const text = (sel, root = document) => clean(root.querySelector?.(sel)?.textContent || "");

  // Wait for profile to render
  for (let i = 0; i < 20; i++) {
    if (document.querySelector('.profile-name, .candName, [class*="profile"], [class*="Profile"]')) break;
    await sleep(400);
  }
  // Scroll to load lazy sections
  for (let i = 0; i < 5; i++) { window.scrollBy(0, 1200); await sleep(400); }
  window.scrollTo(0, 0); await sleep(200);

  const name =
    text('.profile-name, .candName, h1, h2.title') ||
    text('[class*="name" i]');
  const headline =
    text('.designation, .current-designation, .title-info, [class*="designation" i]');
  const location =
    text('.loc, .location, [class*="location" i], [class*="Location" i]');

  // Companies — gather from experience section
  const companies = [];
  const seen = new Set();
  const pushCo = (s) => {
    const v = clean(s).replace(/\s*\(.*?\)\s*$/, "");
    if (!v || v.length < 2 || v.length > 80) return;
    if (/^(present|current|ago|year|month|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(v)) return;
    if (seen.has(v.toLowerCase())) return;
    seen.add(v.toLowerCase()); companies.push(v);
  };
  const expRoot = document.querySelector('.experienceSection, [class*="experience" i], [id*="experience" i]') || document;
  // Naukri tends to show "Designation @ Company" rows
  expRoot.querySelectorAll('.org, .company, [class*="company" i], [class*="Company" i]').forEach((el) => pushCo(el.textContent));
  // Fallback: parse rows split by " @ " or " - "
  expRoot.querySelectorAll('li, .exp-row, .experience-row, .row').forEach((el) => {
    const t = clean(el.textContent);
    const m = t.match(/(?:@|\bat\b|—|-)\s*([A-Z][A-Za-z0-9&., ]{1,60})/);
    if (m) pushCo(m[1]);
  });
  const company = companies[0] || text('.current-company, [class*="currentCompany" i]');

  // Skills
  const skillsList = Array.from(document.querySelectorAll('.skill, .keySkill, [class*="skill" i] li, [class*="Skill" i] span'))
    .map((el) => clean(el.textContent)).filter((s) => s && s.length < 50).slice(0, 40);

  // Availability — Naukri marks active vs inactive via "Active a day ago" etc.
  const bodyTxt = clean(document.body.innerText).slice(0, 4000).toLowerCase();
  let availability = "active";
  if (/active\s+today|active\s+a\s+day\s+ago|active\s+\d+\s+day/.test(bodyTxt)) availability = "active";
  if (/open\s+to\s+(work|opportunit)/.test(bodyTxt)) availability = "open-to-work";
  if (/notice\s+period\s*:\s*(serving|0|immediate|15)/.test(bodyTxt)) availability = "open-to-work";

  // Experience text — bounded snapshot for AI scoring
  const experienceText =
    clean((expRoot.innerText || "")).slice(0, 4000) ||
    clean(document.body.innerText).slice(0, 3000);

  const profileUrl = location_url();
  function location_url() { try { return location_safe(); } catch { return ""; } }
  function location_safe() { return window.location.href.split("#")[0]; }

  return {
    name, headline, company, companies, location, skillsList,
    availability, openToWork: availability === "open-to-work",
    experienceText, profileUrl: window.location.href.split("#")[0],
  };
})();
