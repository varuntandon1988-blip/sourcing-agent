// Injected on demand into an Instahyre candidate profile.
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findBtn = () => {
    const all = Array.from(document.querySelectorAll('a, button'));
    return all.find((b) => {
      const t = (b.innerText || b.getAttribute('title') || b.getAttribute('aria-label') || '').toLowerCase();
      return /download (resume|cv)/.test(t) || (b.href || '').match(/resume|cv/i);
    });
  };
  for (let i = 0; i < 15; i++) {
    const b = findBtn();
    if (b) { b.click(); return { ok: true }; }
    await sleep(500);
  }
  return { ok: false, reason: "No download button found (need Instahyre recruiter)" };
})();
