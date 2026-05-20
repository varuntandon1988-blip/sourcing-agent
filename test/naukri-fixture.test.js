import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("naukri fixture tripwire", () => {
  it("extracts ≥1 card with name and profileUrl from saved card HTML", () => {
    const html = fs.readFileSync(path.join(__dirname, "fixtures/naukri-card.html"), "utf8");
    const dom = new JSDOM(`<html><body>${html}</body></html>`, {
      url: "https://www.naukri.com/resdex/search",
    });
    const { document } = dom.window;

    // Mirrors the card-selector logic in naukri-resdex.js scrape().
    const cardSelectors = [
      ".candidate-tuple", ".candidateTuple", ".cand-tuple",
      '[class*="CandidateCard"]', '[class*="candidate-card"]',
      ".profile-tuple", ".profileTuple", ".cvTuple", ".resTuple",
      ".tuple", '[class*="tuple" i]', '[id^="tuple"]',
    ];
    let cards = [];
    for (const sel of cardSelectors) {
      const f = Array.from(document.querySelectorAll(sel));
      if (f.length > cards.length) cards = f;
    }
    expect(cards.length).toBeGreaterThanOrEqual(1);

    const card = cards[0];
    const link = card.querySelector(
      'a[href*="/resdex/profile/"], a[href*="/resdex/cv/"], a[href*="/profile/"], a[href*="/cv/"]'
    );
    expect(link).not.toBeNull();
    expect(link.textContent.trim().length).toBeGreaterThan(0);

    const profileUrl = new URL(link.getAttribute("href"), "https://www.naukri.com").href.split("?")[0];
    expect(profileUrl).toMatch(/^https?:\/\//);
  });
});
