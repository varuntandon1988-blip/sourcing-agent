// Sets up Naukri Resdex "Search Candidates" form per the handbook:
//  - Enable Boolean toggle on Keywords
//  - Paste boolean into Keywords
//  - Fill Min/Max experience
//  - Fill location chips
//  - Diversity Hiring -> All candidates (or Female if requireFemale)
//  - Display details -> All candidates
//  - Active in -> 60 days
//  - Click Search
//
// Receives { boolean, expMin, expMax, locations, requireFemale } via window.__SOURCING_AGENT_NAUKRI__
(async function () {
  const cfg = window.__SOURCING_AGENT_NAUKRI__ || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[sourcing-agent/naukri]", ...a);

  function nativeSet(el, value) {
    const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findByLabelOrAttr(matchers, tagSel = 'input,textarea') {
    const all = Array.from(document.querySelectorAll(tagSel));
    for (const el of all) {
      const ph = (el.getAttribute("placeholder") || "").toLowerCase();
      const al = (el.getAttribute("aria-label") || "").toLowerCase();
      const id = (el.id || "").toLowerCase();
      const nm = (el.getAttribute("name") || "").toLowerCase();
      const t = ph + " " + al + " " + id + " " + nm;
      if (matchers.some((m) => t.includes(m))) return el;
    }
    return null;
  }

  // Wait for the search form to render
  let keywordsBox = null;
  for (let i = 0; i < 60; i++) {
    keywordsBox =
      document.querySelector('textarea[placeholder*="keyword" i], textarea[placeholder*="skill" i], textarea[placeholder*="designation" i]') ||
      findByLabelOrAttr(["keyword", "boolean"], "textarea") ||
      findByLabelOrAttr(["keyword", "boolean"], "input");
    if (keywordsBox) break;
    await sleep(500);
  }
  if (!keywordsBox) {
    log("Keywords box not found");
    return { ok: false, reason: "keywords-box-not-found" };
  }

  // 1) Enable Boolean toggle (if found and not already on)
  try {
    const labels = Array.from(document.querySelectorAll("label, span, button, div"));
    const tog = labels.find((el) => /^\s*boolean\b/i.test(el.innerText || "") && el.querySelector?.("input,button,[role=switch]"));
    const switchEl = tog?.querySelector?.('input[type="checkbox"], [role="switch"], button');
    if (switchEl) {
      const isOn = switchEl.getAttribute("aria-checked") === "true" || switchEl.checked === true || /on/i.test(switchEl.getAttribute("data-state") || "");
      if (!isOn) { switchEl.click(); await sleep(300); log("Boolean toggle enabled"); }
    } else {
      // Sometimes a plain "Boolean" text element acts as the toggle
      const plain = Array.from(document.querySelectorAll("span,button,a,div"))
        .find((el) => /^\s*boolean\s*$/i.test((el.innerText || "").trim()) && el.offsetParent);
      if (plain) { plain.click(); await sleep(300); log("Boolean text clicked"); }
    }
  } catch (e) { log("Boolean toggle skipped:", e.message); }

  // 2) Paste boolean into keywords
  keywordsBox.focus();
  if (keywordsBox.tagName === "TEXTAREA" || keywordsBox.tagName === "INPUT") {
    nativeSet(keywordsBox, cfg.boolean || "");
  } else {
    keywordsBox.textContent = cfg.boolean || "";
    keywordsBox.dispatchEvent(new InputEvent("input", { bubbles: true, data: cfg.boolean || "" }));
  }
  await sleep(400);
  log("Boolean pasted");

  // 3) Experience min/max
  try {
    const expInputs = Array.from(document.querySelectorAll('input'))
      .filter((el) => {
        const t = ((el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.id || "") + " " + (el.name || "")).toLowerCase();
        return /(min|max).*(exp|year)|exp.*(min|max)|^min$|^max$|minexp|maxexp/.test(t) || /experience/.test(t);
      });
    // Fallback: any pair near a label "Experience"
    let minEl = expInputs.find((el) => /min/i.test((el.placeholder || "") + (el.name || "") + (el.id || "")));
    let maxEl = expInputs.find((el) => /max/i.test((el.placeholder || "") + (el.name || "") + (el.id || "")));
    if (!minEl || !maxEl) {
      const lbl = Array.from(document.querySelectorAll("label,span,div"))
        .find((el) => /^\s*experience\s*$/i.test((el.innerText || "").trim()));
      if (lbl) {
        const wrap = lbl.closest("section,div,form") || document;
        const ins = Array.from(wrap.querySelectorAll('input')).filter((el) => el.offsetParent);
        minEl = minEl || ins[0]; maxEl = maxEl || ins[1];
      }
    }
    if (minEl && cfg.expMin != null && cfg.expMin !== "") { nativeSet(minEl, String(cfg.expMin)); }
    if (maxEl && cfg.expMax != null && cfg.expMax !== "") { nativeSet(maxEl, String(cfg.expMax)); }
    await sleep(300);
    log("Experience set", cfg.expMin, cfg.expMax);
  } catch (e) { log("exp skipped:", e.message); }

  // 4) Locations: type each + Enter
  try {
    const locInput =
      document.querySelector('input[placeholder*="location" i]') ||
      findByLabelOrAttr(["location", "city"], "input");
    if (locInput && Array.isArray(cfg.locations)) {
      for (const loc of cfg.locations) {
        if (!loc) continue;
        locInput.focus();
        nativeSet(locInput, loc);
        await sleep(700);
        // Try to click first dropdown suggestion
        const sug = document.querySelector('.suggestor-content li, .ui-autocomplete li, [role="option"], .dropdown-suggestion li, .suggestion-item');
        if (sug) { sug.click(); }
        else {
          for (const type of ["keydown", "keypress", "keyup"]) {
            locInput.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
          }
        }
        await sleep(400);
      }
      log("Locations set", cfg.locations);
    }
  } catch (e) { log("location skipped:", e.message); }

  // 5) Diversity Hiring -> All candidates (or Female)
  try {
    const wantedLabel = cfg.requireFemale ? /female\s+candidates/i : /all\s+candidates/i;
    // Find within "Diversity Hiring" section
    const divHdr = Array.from(document.querySelectorAll("h2,h3,h4,div,span,label"))
      .find((el) => /diversity\s+hiring/i.test((el.innerText || "").trim()));
    const scope = divHdr?.closest("section,div,form") || document;
    const opts = Array.from(scope.querySelectorAll("label, button, span, div"))
      .filter((el) => wantedLabel.test((el.innerText || "").trim()) && el.offsetParent);
    if (opts[0]) { opts[0].click(); await sleep(200); log("Diversity:", cfg.requireFemale ? "Female" : "All"); }
  } catch (e) { log("diversity skipped:", e.message); }

  // 6) Display details -> All candidates
  try {
    const dispHdr = Array.from(document.querySelectorAll("h2,h3,h4,div,span,label"))
      .find((el) => /display\s+details/i.test((el.innerText || "").trim()));
    const scope = dispHdr?.closest("section,div,form") || document;
    const opt = Array.from(scope.querySelectorAll("label, button, span, div"))
      .find((el) => /^\s*all\s+candidates\s*$/i.test((el.innerText || "").trim()) && el.offsetParent);
    if (opt) { opt.click(); await sleep(200); log("Display details: All candidates"); }
  } catch (e) { log("display skipped:", e.message); }

  // 7) Active in -> N days (default 15)
  try {
    const days = Number(cfg.activeInDays) > 0 ? Number(cfg.activeInDays) : 15;
    const dayRx = new RegExp("\\b" + days + "\\s*day", "i");
    const sel = Array.from(document.querySelectorAll("select")).find((s) => /active/i.test(s.name || s.id || (s.previousElementSibling?.innerText || "")));
    if (sel) {
      const opt = Array.from(sel.options).find((o) => dayRx.test(o.text));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); log("Active in: " + days + " days (select)"); }
    } else {
      const actHdr = Array.from(document.querySelectorAll("label,span,div,button"))
        .find((el) => /active\s+in/i.test((el.innerText || "").trim()) && el.offsetParent);
      if (actHdr) {
        actHdr.click(); await sleep(400);
        const opt = Array.from(document.querySelectorAll("li, label, button, span, div"))
          .find((el) => dayRx.test((el.innerText || "").trim()) && el.offsetParent);
        if (opt) { opt.click(); log("Active in: " + days + " days"); }
      }
    }
    await sleep(300);
  } catch (e) { log("active skipped:", e.message); }

  // 8) Click "Search candidates" button
  await sleep(400);
  const btn =
    Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
      .find((b) => /search\s+candidates|^search$/i.test((b.innerText || b.value || "").trim()) && !b.disabled && b.offsetParent);
  if (!btn) {
    log("Search button not found");
    return { ok: true, searched: false, reason: "search-button-not-found" };
  }
  btn.scrollIntoView({ block: "center" });
  btn.click();
  log("Search clicked");
  return { ok: true, searched: true };
})();
