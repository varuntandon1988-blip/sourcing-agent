// ESM shim exporting the four pure parser functions from content/naukri-resdex.js.
// Keep in sync with the source file — these functions are identical copies.
const _clean = (s) => (s || "").replace(/\s+/g, " ").trim();

export function parseExperience(card) {
  const t = _clean(card.textContent);
  let m = t.match(/(\d{1,2})\s*y(?:rs?)?\s*(\d{1,2})?\s*m?/i);
  if (m) return { years: +m[1], months: +(m[2] || 0) };
  m = t.match(/(\d{1,2})\s*years?/i);
  if (m) return { years: +m[1], months: 0 };
  return { years: null, months: null };
}

export function parseCTC(card) {
  const t = _clean(card.textContent);
  let m = t.match(/(?:₹|Rs\.?)\s*([\d.]+)\s*(?:Lacs|Lakhs|L|LPA)/i);
  if (m) return parseFloat(m[1]);
  m = t.match(/([\d.]+)\s*(?:Lacs|Lakhs|LPA)/i);
  if (m) return parseFloat(m[1]);
  return null;
}

export function splitCurrent(s) {
  if (!s) return { title: "", company: "" };
  const m = s.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (m) return { title: _clean(m[1]), company: _clean(m[2]) };
  return { title: s, company: "" };
}

export function extractCollege(eduText) {
  if (!eduText) return "";
  const fromMatch = eduText.match(/from\s+([A-Z][A-Za-z .,&()\-]{3,80})/);
  if (fromMatch) return _clean(fromMatch[1]);
  const slash = eduText.split("/").pop();
  if (slash) return _clean(slash.replace(/\b\d{4}\b/g, ""));
  return _clean(eduText.replace(/\b\d{4}\b/g, ""));
}
