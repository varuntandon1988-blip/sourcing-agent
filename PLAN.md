# Engineering Plan — Deep-Scrape Fix (v1.12.2 → v1.13.0)

## Root cause

`openProfileInNewTab` in `background.js` dispatched synthetic `MouseEvent`s on
name links, relying on `target="_blank"` to open a new tab. Browsers gate
new-tab-opening behind **user activation**; synthetic events never qualify, so
the click fires but no tab opens. This is a hard browser security boundary.

## Fix summary

**File: `background.js` (lines ~1137–1212)**
- Primary path: if `profileUrl` is a valid `https?://` URL, call
  `chrome.tabs.create({ url: profileUrl, active: false, openerTabId })` directly.
- Fallback: run the existing scripting.executeScript block to extract a URL
  from the DOM (for portals where profileUrl may be empty), then open it via
  `chrome.tabs.create`. The `MouseEvent` dispatch loop is removed from the
  fallback — it was never able to open tabs and is no longer needed; only the
  href extraction remains.

**File: `content/naukri-resdex.js`**
- Pure parser functions (`parseExperience`, `parseCTC`, `splitCurrent`,
  `extractCollege`) hoisted above the IIFE so they share file scope.
- One `console.log` per scrape run: logs which cardSelector matched, how many
  cards were found, and whether the first card's profile link resolved.

**File: `content/instahyre-recruiter.js`**
- Same one-line log added to `scrape()`.

**New: `package.json`**
- `"type": "module"`, `devDependencies`: `vitest ^1.6.0`, `jsdom ^24.0.0`.
- `npm test` runs `vitest run`.

**New: `test/naukri-parsers.js`**
- ESM shim re-exporting the four parser functions for Node tests.
  (Content scripts are plain browser scripts and cannot be imported as ESM.)

**New: `test/parsers.test.js`**
- 18 unit tests covering happy path and edge cases for all four parsers.

**New: `test/fixtures/naukri-card.html` + `test/naukri-fixture.test.js`**
- Saved card outerHTML; tripwire confirms ≥1 card found and profileUrl
  constructable.

**New: `test/fixtures/instahyre-card.html` + `test/instahyre-fixture.test.js`**
- Same for Instahyre.

**`manifest.json`**: version bumped to `1.13.0`.
**`CHANGELOG.md`**: entry added.

## Open questions resolved

1. `profileUrl` extraction confirmed correct in naukri-resdex.js — the
   `findProfileLink` function walks standard Naukri href selectors before
   falling back to onclick/name heuristics. Log line now surfaces this on
   every run.
2. Instahyre profile URL comes from the `href` attribute directly; no route
   handler interception needed.
3. `chrome.tabs.create` preserves session/cookies (same browser profile).
4. Concurrency unchanged — sequential to avoid anti-bot detection.

## Verification steps

1. `npm test` — 20 tests, all green.
2. Load unpacked extension, run against live Naukri Resdex search (≥25 results),
   confirm ≥20 profile tabs open and are scored within 10 minutes.
3. Same for Instahyre.
4. LinkedIn smoke test — confirm no regression.
