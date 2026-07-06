import { describe, expect, it } from "vitest";
import { parseGridId, formatCarbon, formatCarbonCompact } from "../index";

// parseGridId / formatCarbon / formatCarbonCompact are pure (no module state),
// so they can be imported and tested directly — unlike buildEnergyText /
// buildQuotaText which depend on session state and are replicated in
// progressive-disclosure.test.ts.

describe("parseGridId", () => {
  it("parses bare ISO country codes (flag + code-as-short)", () => {
    expect(parseGridId("FI")).toEqual({ country: "FI", flag: "🇫🇮", short: "FI", name: "FI" });
    expect(parseGridId("FR")).toEqual({ country: "FR", flag: "🇫🇷", short: "FR", name: "FR" });
  });

  it("parses CC-SUBREGION-BA codes (country flag + BA short tag)", () => {
    expect(parseGridId("US-MIDA-PJM")).toEqual({ country: "US", flag: "🇺🇸", short: "PJM", name: "US-MIDA-PJM" });
    expect(parseGridId("US-CAL-CISO")).toEqual({ country: "US", flag: "🇺🇸", short: "CISO", name: "US-CAL-CISO" });
    expect(parseGridId("US-CAR-DUK")).toEqual({ country: "US", flag: "🇺🇸", short: "DUK", name: "US-CAR-DUK" });
  });

  it("derives a flag for any 2-letter country via regional indicators (no hardcoded map)", () => {
    // Grids Neuralwatt doesn't serve today must still render sanely without a
    // code change — this is the whole point of not hardcoding the ID list.
    expect(parseGridId("DE-50Hertz")).toEqual({ country: "DE", flag: "🇩🇪", short: "50Hertz", name: "DE-50Hertz" });
    expect(parseGridId("NO-NO1")).toEqual({ country: "NO", flag: "🇳🇴", short: "NO1", name: "NO-NO1" });
    expect(parseGridId("GB-NGC")).toEqual({ country: "GB", flag: "🇬🇧", short: "NGC", name: "GB-NGC" });
  });

  it("returns an empty flag for a non-2-letter country code (text-only badge)", () => {
    expect(parseGridId("WORLD-BA")).toEqual({ country: "WORLD", flag: "", short: "BA", name: "WORLD-BA" });
  });

  it("flags are exactly the two regional-indicator code points for the country", () => {
    expect(parseGridId("US-MIDA-PJM").flag).toBe("\u{1F1FA}\u{1F1F8}"); // 🇺🇸
    expect(parseGridId("FI").flag).toBe("\u{1F1EB}\u{1F1EE}"); // 🇫🇮
  });
});

describe("formatCarbon", () => {
  it("formats milligrams below 1 g", () => {
    expect(formatCarbon(0)).toBe("0 g");
    expect(formatCarbon(0.5)).toBe("500.00 mg");
    expect(formatCarbon(0.001)).toBe("1.00 mg");
  });

  it("formats grams with adaptive precision (2 → 1 → 0 decimals)", () => {
    expect(formatCarbon(1.24)).toBe("1.24 g");
    expect(formatCarbon(42.5)).toBe("42.5 g");
    expect(formatCarbon(172)).toBe("172 g");
  });

  it("formats kilograms at 1000 g+", () => {
    expect(formatCarbon(1234)).toBe("1.23 kg");
  });
});

describe("formatCarbonCompact", () => {
  it("mirrors formatCarbon with no space before the unit", () => {
    expect(formatCarbonCompact(0)).toBe("0g");
    expect(formatCarbonCompact(0.5)).toBe("500.00mg");
    expect(formatCarbonCompact(1.24)).toBe("1.24g");
    expect(formatCarbonCompact(1234)).toBe("1.23kg");
  });

  it("compact is never wider than spaced", () => {
    for (const g of [0, 0.001, 0.5, 1.24, 42.5, 172, 1234]) {
      expect(formatCarbonCompact(g).length).toBeLessThanOrEqual(formatCarbon(g).length);
    }
  });
});
