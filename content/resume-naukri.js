// Injected on demand into a Naukri Resdex / RMS candidate profile.
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findBtn = () => {
    const all = Array.from(document.querySelectorAll('a, button, [role=button]'));
    return all.find((b) => {
      const t = (b.innerText || b.getAttribute('title') || b.getAttribute('aria-label') || '').toLowerCase();
      return /download (cv|resume)|view (cv|resume)/.test(t);
    });
  };
  for (let i = 0; i < 15; i++) {
    const b = findBtn();
    if (b) { b.click(); return { ok: true }; }
    await sleep(500);
  }
  return { ok: false, reason: "No download button found (need Resdex/RMS seat)" };
})();
