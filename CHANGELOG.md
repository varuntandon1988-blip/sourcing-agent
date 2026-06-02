# Changelog

## [2.0.3] — 2026-06-02

### Fixed

**Instahyre scraper TDZ crash (full scrape returned zero candidates)**

`content/instahyre-recruiter.js` had a temporal dead zone bug. Inside the per-card
`forEach` callback, `new URL(rawHref, location.href)` (line ~95) referenced the
global `location`, but a later `const location = text(c, '[class*="location"]')`
declaration (line ~120) hoisted a block-scoped binding for `location` into the TDZ
for the entire callback. Any card with a real `https://` href threw
`ReferenceError: Cannot access 'location' before initialization`, which propagated
out of `forEach` and returned zero candidates to the agent.

Fix: renamed the block-scoped variable to `locationText` in
`instahyre-recruiter.js`. The same rename was applied to all other non-LinkedIn
content scripts that shadow the global `location` (`instahyre-profile.js`,
`instahyre.js`, `naukri.js`, `naukri-profile.js`) to prevent the same class of
bug from reappearing.

**Instahyre SPA pagination never advances past page 1**

Instahyre is an AngularJS single-page app. Clicking "Next" triggers a client-side
re-render — the browser fires no `tabs.onUpdated complete` event — so the previous
`waitForTabLoad` burned its full 25 s timeout on the same DOM. The subsequent
re-scrape returned identical cards; the dedup `seen` set filtered them all; the
loop stopped with "Empty page".

Fix: added `pollUntilListChanges(tabId, scriptFile, prevFirstKey, timeoutMs = 15000)`
which polls the scraper every second until the first candidate key changes,
confirming the SPA has rendered new results. In `runPortalAgent`, the `page > 1`
navigation block now forks on `portal === "instahyre"`: click Next then poll,
versus the existing click + `waitForTabLoad` path for standard portals (Naukri
etc.). The polled cands are reused directly — no redundant second scrape.

⚠ **Next-button selector needs live verification.** The selectors used
(`button[aria-label="Next"]`, `[class*="pagination"] a:last-child`, text
"Next"/›/») are generic heuristics that have not been verified against a live
Instahyre recruiter search page. Inspect the actual DOM and update the `sels`
array in `runPortalAgent` if they don't match.

**Naukri agent stops after first profile — diagnostics added**

The root cause (single-card selector collapse or per-candidate exception) is
unconfirmed without live DOM data. Diagnostics added to narrow it down:

- `naukri-resdex.js` now returns `{ cands, selectorLog }` instead of a plain
  array. `selectorLog` contains the matched card selector name and raw card count N.
- A new `unwrapScraperResult()` helper in `background.js` normalises both the
  old plain-array format (Instahyre, LinkedIn) and the new wrapper format (Naukri).
- `runNaukriAgent` calls `logAgent(selectorLog)` immediately after scraping,
  surfacing N in the agent log without requiring DevTools on the results tab.
  Look for: `[naukri] cardSelector "..." → N cards`.
- The `for (const c of cands)` loop body in `runNaukriAgent` is now wrapped in
  try/catch; an error on one candidate logs and continues rather than aborting
  the whole page.

**Next step for Naukri:** run the agent, note the N value in the log line above,
and report back. If N = 1, paste the candidate card HTML so the correct selector
can be pinpointed.

## [1.13.0] — 2026-05-20

### Fixed

- **Naukri and Instahyre deep-scrape now opens profile tabs reliably via
  `chrome.tabs.create` instead of synthetic click events.** Browsers block
  new-tab opening for programmatic `MouseEvent` dispatches (no user
  activation); `chrome.tabs.create` bypasses this constraint entirely.
  Zero-tab regression on both portals is resolved.

### Added

- Minimal scrape logging in both portal content scripts: one `console.log`
  per run showing which card selector matched, how many cards were found,
  and whether the first card's profile link resolved.
- Parser unit tests (`test/parsers.test.js`): 18 tests covering
  `parseExperience`, `parseCTC`, `splitCurrent`, `extractCollege`.
- Fixture tripwire tests for Naukri and Instahyre: saved card HTML confirms
  selector and link extraction remain functional as portal markup evolves.
