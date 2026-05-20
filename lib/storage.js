// Thin wrapper over chrome.storage.local — all data is local to this Chrome profile.
// Keys:
//   settings         { aiProvider, aiKey, aiModel, deviceId }
//   companyLists     [{ id, name, isFocus, sortOrder, companies: [] }]
//   roles            [{ id, title, jdText, parsed, categories[], customCompanies[], skills[], locations[], expMin, expMax,
//                       mustHave[], excludeKeywords[], excludeCompanies[], includeITServices, idealResumes:[{name,text}], createdAt }]
//   searchStrings    [{ id, roleId, portal, query, status, createdAt }]
//   searches         [{ id, roleId, portal, status, startedAt, finishedAt, count, error }]
//   candidates       [{ id, searchId, roleId, portal, name, headline, company, location, profileUrl, snippet, score, matchedSkills[], gaps[], rationale, createdAt }]
//   queue            [{ id, roleId, searchStringId, portal, query, status, createdAt }]

export const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  Math.random().toString(36).slice(2) + Date.now().toString(36);

export async function getAll(key, fallback = []) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}
export async function setAll(key, value) {
  await chrome.storage.local.set({ [key]: value });
}
export async function append(key, item) {
  const list = await getAll(key, []);
  list.push(item);
  await setAll(key, list);
  return item;
}
export async function update(key, id, patch) {
  const list = await getAll(key, []);
  const i = list.findIndex((x) => x.id === id);
  if (i === -1) return null;
  list[i] = { ...list[i], ...patch };
  await setAll(key, list);
  return list[i];
}
export async function remove(key, id) {
  const list = await getAll(key, []);
  await setAll(key, list.filter((x) => x.id !== id));
}
export async function getSettings() {
  const s = await getAll("settings", {});
  if (!s.deviceId) {
    s.deviceId = uid();
    s.aiProvider = s.aiProvider || "gemini";
    s.aiModel = s.aiModel || "gemini-2.5-flash";
    await setAll("settings", s);
  }
  return s;
}
export async function saveSettings(patch) {
  const s = await getSettings();
  const next = { ...s, ...patch };
  await setAll("settings", next);
  return next;
}
