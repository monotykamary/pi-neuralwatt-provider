import { describe, expect, it } from "vitest";
import {
  ASCII_GLYPHS,
  UNICODE_GLYPHS,
  detectLegacyTerminal,
  flexLiveTiers,
  parseGridId,
  resolveGlyphSet,
  resolveWidgetGlyphSet,
} from "../index";

const mintty = { TERM_PROGRAM: "mintty", TERM: "xterm" } as NodeJS.ProcessEnv;
const cygwin = { TERM: "cygwin" } as NodeJS.ProcessEnv;
const msys = { TERM_PROGRAM: "msys" } as NodeJS.ProcessEnv;
const windowsTerminal = { TERM_PROGRAM: "Windows_Terminal", TERM: "xterm-256color" } as NodeJS.ProcessEnv;

const isAscii = (s: string) => [...s].every((c) => c.charCodeAt(0) < 128);

describe("legacy terminal detection", () => {
  it("matches mintty/Cygwin/MSYS and nothing else", () => {
    expect(detectLegacyTerminal(mintty)).toBe(true);
    expect(detectLegacyTerminal(cygwin)).toBe(true);
    expect(detectLegacyTerminal(msys)).toBe(true);
    expect(detectLegacyTerminal(windowsTerminal)).toBe(false);
    expect(detectLegacyTerminal({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("glyph resolution", () => {
  it("auto degrades on legacy terminals only", () => {
    expect(resolveGlyphSet("auto", mintty)).toBe(ASCII_GLYPHS);
    expect(resolveGlyphSet("auto", windowsTerminal)).toBe(UNICODE_GLYPHS);
  });

  it("explicit modes win for the statusbar", () => {
    expect(resolveGlyphSet("unicode", mintty)).toBe(UNICODE_GLYPHS);
    expect(resolveGlyphSet("ascii", windowsTerminal)).toBe(ASCII_GLYPHS);
  });

  it("clamps explicit unicode for widget content on legacy terminals", () => {
    expect(resolveWidgetGlyphSet("unicode", mintty)).toBe(ASCII_GLYPHS);
    expect(resolveWidgetGlyphSet("unicode", windowsTerminal)).toBe(UNICODE_GLYPHS);
    expect(resolveWidgetGlyphSet("auto", mintty)).toBe(ASCII_GLYPHS);
    expect(resolveWidgetGlyphSet("ascii", windowsTerminal)).toBe(ASCII_GLYPHS);
  });
});

describe("glyph sets", () => {
  it("the ASCII set is pure ASCII and the unicode set is not", () => {
    expect(isAscii(Object.values(ASCII_GLYPHS).join(""))).toBe(true);
    expect(isAscii(Object.values(UNICODE_GLYPHS).join(""))).toBe(false);
  });

  it("ASCII flex badge keeps the discount and wait readable", () => {
    const tiers = flexLiveTiers(7, 82, ASCII_GLYPHS);
    expect(tiers[0]).toBe("flex -82% - queued 00:07");
    expect(isAscii(tiers.join(""))).toBe(true);
    expect(flexLiveTiers(7, 82)[0]).toBe("flex \u221282% \u00b7 queued 00:07");
  });

  it("ASCII region badge uses the country code instead of a flag", () => {
    // A regional-indicator pair is 2 code points (4 UTF-16 units)
    expect(Array.from(parseGridId("US-MIDA-PJM").flag).length).toBe(2);
    expect(parseGridId("US-MIDA-PJM", ASCII_GLYPHS).flag).toBe("US");
    expect(Array.from(parseGridId("US-MIDA-PJM", UNICODE_GLYPHS).flag).map((c) => c.codePointAt(0))).toEqual([
      0x1f1fa, 0x1f1f8,
    ]);
    expect(isAscii(parseGridId("FI", ASCII_GLYPHS).flag)).toBe(true);
  });
});
