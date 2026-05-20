// Injected on demand by background.js into a LinkedIn profile (Recruiter)
// to trigger the resume download. Recruiter / Recruiter Lite only.
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findBtn = () => {
    const candidates = Array.from(document.querySelectorAll('button, a'));
    return candidates.find((b) => {
      const t = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase();
      return /download (resume|cv)|resume.*download|attached resume/.test(t);
    });
  };
  for (let i = 0; i < 15; i++) {
    const b = findBtn();
    if (b) { b.click(); return { ok: true }; }
    await sleep(500);
  }
  return { ok: false, reason: "No download button found (need Recruiter seat & uploaded resume)" };
})();
