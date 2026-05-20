import { describe, it, expect } from "vitest";
import { parseExperience, parseCTC, splitCurrent, extractCollege } from "./naukri-parsers.js";

// Minimal DOM stub — parsers only need .textContent.
const card = (text) => ({ textContent: text });

describe("parseExperience", () => {
  it("parses compact format: 8y 4m", () => {
    expect(parseExperience(card("8y 4m"))).toEqual({ years: 8, months: 4 });
  });
  it("parses long format: 13 yrs 6 mo", () => {
    expect(parseExperience(card("13 yrs 6 mo"))).toEqual({ years: 13, months: 6 });
  });
  it("parses years-only: 5 years", () => {
    expect(parseExperience(card("5 years experience"))).toEqual({ years: 5, months: 0 });
  });
  it("returns nulls when no experience text found", () => {
    expect(parseExperience(card("No experience info"))).toEqual({ years: null, months: null });
  });
  it("handles leading context: 'Exp: 2y 0m | Delhi'", () => {
    const result = parseExperience(card("Exp: 2y 0m | Delhi"));
    expect(result.years).toBe(2);
    expect(result.months).toBe(0);
  });
});

describe("parseCTC", () => {
  it("parses rupee symbol format: ₹46.37 Lacs", () => {
    expect(parseCTC(card("₹46.37 Lacs"))).toBeCloseTo(46.37);
  });
  it("parses Rs format: Rs 12 Lacs", () => {
    expect(parseCTC(card("Rs 12 Lacs"))).toBe(12);
  });
  it("parses LPA format: 12.5 LPA", () => {
    expect(parseCTC(card("12.5 LPA"))).toBeCloseTo(12.5);
  });
  it("parses Lakhs format: 18 Lakhs", () => {
    expect(parseCTC(card("18 Lakhs"))).toBe(18);
  });
  it("returns null when no CTC found", () => {
    expect(parseCTC(card("Python | Spark | SQL"))).toBeNull();
  });
});

describe("splitCurrent", () => {
  it("splits on 'at': Senior Data Engineer at PepsiCo", () => {
    expect(splitCurrent("Senior Data Engineer at PepsiCo")).toEqual({
      title: "Senior Data Engineer",
      company: "PepsiCo",
    });
  });
  it("splits on '@': Lead SRE @ Amazon", () => {
    expect(splitCurrent("Lead SRE @ Amazon")).toEqual({
      title: "Lead SRE",
      company: "Amazon",
    });
  });
  it("returns full string as title when no separator", () => {
    expect(splitCurrent("CTO")).toEqual({ title: "CTO", company: "" });
  });
  it("returns empty strings for falsy input", () => {
    expect(splitCurrent("")).toEqual({ title: "", company: "" });
    expect(splitCurrent(null)).toEqual({ title: "", company: "" });
  });
});

describe("extractCollege", () => {
  it("extracts college from 'from' clause", () => {
    const result = extractCollege("B.Tech from IIT Bombay 2015");
    expect(result).toContain("IIT Bombay");
  });
  it("extracts college from slash-separated: 'B.Tech / IIT Delhi 2011'", () => {
    const result = extractCollege("B.Tech / IIT Delhi 2011");
    expect(result).toContain("IIT Delhi");
    expect(result).not.toMatch(/\b2011\b/);
  });
  it("strips trailing year", () => {
    const result = extractCollege("MBA 2018");
    expect(result).not.toMatch(/\b2018\b/);
  });
  it("returns empty string for falsy input", () => {
    expect(extractCollege("")).toBe("");
    expect(extractCollege(null)).toBe("");
  });
});
