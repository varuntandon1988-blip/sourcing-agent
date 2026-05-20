// Deep profile scraper. Runs on a LinkedIn profile page (/in/ or /talent/profile/).
// Returns enriched fields used for stronger AI scoring.
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const grab = (sel) => clean(document.querySelector(sel)?.textContent);

  // Wait for the main profile shell
  for (let i = 0; i < 25; i++) {
    if (document.querySelector('main, .scaffold-layout__main, .profile, [data-test-profile-component]')) break;
    await sleep(400);
  }
  // Scroll to trigger lazy sections (Experience, Education, Skills)
  for (let i = 0; i < 6; i++) { window.scrollBy(0, 1200); await sleep(450); }
  window.scrollTo(0, 0); await sleep(300);

  const name = grab('h1') || grab('[data-anonymize="person-name"]');
  const headline = grab('.text-body-medium.break-words')
    || grab('[data-anonymize="headline"]')
    || grab('.top-card-layout__headline');
  const locationText = grab('.text-body-small.inline.t-black--light.break-words')
    || grab('[data-anonymize="location"]');

  // About / summary
  let about = "";
  const aboutHeader = Array.from(document.querySelectorAll('h2, h3, span'))
    .find((el) => /^About$/i.test(clean(el.textContent)));
  if (aboutHeader) {
    const section = aboutHeader.closest('section');
    about = clean(section?.innerText || "").replace(/^About\s*/i, "").slice(0, 1500);
  }

  // Experience: collect first ~8 rows + extract company names list
  const experiences = [];
  const companies = [];
  const pushCompany = (raw) => {
    if (!raw) return;
    let v = clean(raw).split("·")[0].trim();
    // drop strings that look like dates / employment types / durations
    if (!v || v.length > 80) return;
    if (/\b(full[- ]time|part[- ]time|contract|internship|freelance|self[- ]employed)\b/i.test(v)) return;
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|present|\d{4})/i.test(v)) return;
    if (/\b\d{4}\b.*\b(present|\d{4})\b/i.test(v)) return;
    if (/^\d+\s+(yr|yrs|year|years|mo|mos|month|months)/i.test(v)) return;
    if (companies.some((c) => c.toLowerCase() === v.toLowerCase())) return;
    companies.push(v);
  };
  const expHeader = Array.from(document.querySelectorAll('h2, h3, span'))
    .find((el) => /^Experience$/i.test(clean(el.textContent)));
  if (expHeader) {
    const section = expHeader.closest('section');
    const rows = Array.from(section?.querySelectorAll('li') || []).slice(0, 12);
    for (const r of rows) {
      const t = clean(r.innerText).split("\n").map(clean).filter(Boolean);
      if (!t.length) continue;
      experiences.push(t.slice(0, 4).join(" — "));
      // Heuristic: company is typically t[1]; if t[0] looks like a company (no role keywords), use t[0]
      pushCompany(t[1] || t[0]);
    }
    // Also try explicit company-name nodes in the section
    const compNodes = Array.from(section?.querySelectorAll('[data-anonymize="company-name"], a[href*="/company/"] span[aria-hidden="true"]') || []);
    for (const n of compNodes) pushCompany(n.textContent);
  }

  // Skills
  const skills = [];
  const skillsHeader = Array.from(document.querySelectorAll('h2, h3, span'))
    .find((el) => /^Skills$/i.test(clean(el.textContent)));
  if (skillsHeader) {
    const section = skillsHeader.closest('section');
    const items = Array.from(section?.querySelectorAll('span[aria-hidden="true"], a span') || []);
    for (const it of items) {
      const v = clean(it.textContent);
      if (v && v.length < 60 && !skills.includes(v)) skills.push(v);
      if (skills.length >= 25) break;
    }
  }

  // Current company guess — try multiple strategies
  let company = "";
  // 1) Top card "current company" pill (button under name)
  const currentBtn = document.querySelector('button[aria-label^="Current company"], a[aria-label^="Current company"], [data-anonymize="company-name"]');
  if (currentBtn) company = clean(currentBtn.textContent);
  // 2) First experience row — first non-empty line is usually role, second is company
  if (!company && experiences.length) {
    const firstLines = clean(experiences[0]).split(" — ");
    company = firstLines[1] || firstLines[0] || "";
    // strip trailing "· Full-time" etc.
    company = company.split("·")[0].trim();
  }
  // 3) Headline pattern "Role at Company"
  if (!company && headline) {
    const m = headline.split(/ at | @ /i);
    if (m[1]) company = clean(m[1]).split(/[,|·]/)[0].trim();
  }

  // Open to work / Hiring detection
  const pageText = clean(document.body.innerText).toLowerCase();
  let availability = "unknown";
  const openToWork =
    !!document.querySelector('[aria-label*="Open to work" i], [data-test-id*="open-to-work" i]') ||
    /#?open[_ ]to[_ ]work/i.test(document.body.innerHTML) ||
    /open to work/i.test(pageText.slice(0, 4000));
  const hiring =
    !!document.querySelector('[aria-label*="hiring" i]') ||
    /\b#?hiring\b/i.test(pageText.slice(0, 2000));
  if (openToWork) availability = "open_to_work";
  else if (hiring) availability = "hiring";
  else availability = "active"; // default — has a live profile we can scrape

  // Make sure current "company" (if found via top-card pill) is included in companies list, at the front
  if (company && !companies.some((c) => c.toLowerCase() === company.toLowerCase())) {
    companies.unshift(company);
  }

  return {
    name, headline, location: locationText, company,
    companies,
    about,
    experienceText: experiences.join(" | ").slice(0, 2500),
    skillsList: skills,
    availability,
    openToWork,
    profileUrl: window.location.href.split("?")[0],
  };
})();
