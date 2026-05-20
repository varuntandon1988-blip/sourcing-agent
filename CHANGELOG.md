# Changelog

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
