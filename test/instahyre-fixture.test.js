import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("instahyre fixture tripwire", () => {
  it("extracts ≥1 card with name and profileUrl from saved card HTML", () => {
    const html = fs.readFileSync(path.join(__dirname, "fixtures/instahyre-card.html"), "utf8");
    const dom = new JSDOM(`<html><body>${html}</body></html>`, {
      url: "https://www.instahyre.com/recruiter/search/",
    });
    const { document } = dom.window;

    // Mirrors the card-selector logic in instahyre-recruiter.js scrape().
    const cardSelectors = [
      ".candidate-card", ".candidate-row", '[class*="CandidateCard"]',
      '[class*="candidate-tile"]', '[data-test*="candidate"]',
      'div[ng-repeat*="candidate"]', ".candidate", "li.candidate",
    ];
    let cards = [];
    for (const sel of cardSelectors) {
      const f = Array.from(document.querySelectorAll(sel));
      if (f.length > cards.length) cards = f;
    }
    expect(cards.length).toBeGreaterThanOrEqual(1);

    const card = cards[0];
    const linkSels = [
      'a[href*="/candidate/"]', 'a[href*="/profile/"]',
      'a[href*="/c/"]', ".candidate-name a", '[class*="Name"] a', "h3 a", "h4 a",
    ];
    let link = null;
    for (const s of linkSels) { link = card.querySelector(s); if (link) break; }
    expect(link).not.toBeNull();
    expect(link.href).toMatch(/^https?:\/\//);

    const name =
      card.querySelector(".candidate-name, h3, h4")?.textContent?.trim() ||
      link?.textContent?.trim();
    expect(name.length).toBeGreaterThan(0);
  });
});
