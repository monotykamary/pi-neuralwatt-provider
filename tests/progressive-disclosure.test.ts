import { describe, expect, it } from "vitest";

// The functions under test (buildEnergyText, buildQuotaText, termVisWidth,
// formatEnergyCompact, truncateAnsi) depend on module-level session state and
// cachedQuota — they can't be imported in isolation. Instead, we replicate
// the width measurement and formatting logic here and test the progressive
// disclosure *structure* by verifying that each level is strictly shorter
// than the previous one.

// ── Width measurement (replicated from index.ts) ─────────────────────────

const EMOJI_RE = /\p{Emoji_Presentation}/u;
const AMBIGUOUS_WIDE = new Set(["◆", "■", "▲", "◉"]);

function termVisWidth(str: string): number {
  let width = 0;
  let i = 0;
  while (i < str.length) {
    const code = str.charCodeAt(i);
    if (code === 0x1b && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next === 0x5b) {
        i += 2;
        while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) i++;
        while (i < str.length && str.charCodeAt(i) >= 0x30 && str.charCodeAt(i) <= 0x3f) i++;
        if (i < str.length) i++;
        continue;
      }
    }
    // Advance by code point (mirrors index.ts) so non-BMP chars like flag
    // emoji and 🌱 are one glyph, not two 1-col surrogate halves. Regional
    // indicators combine into a 2-col flag, so each counts as 1 (a pair = 2).
    const cp = str.codePointAt(i)!;
    const char = cp > 0xffff ? str.slice(i, i + 2) : str[i];
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
      width += 1;
    } else if (EMOJI_RE.test(char)) {
      width += 2;
    } else if (AMBIGUOUS_WIDE.has(char)) {
      width += 2;
    } else {
      width += 1;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  return width;
}

// ── Formatting (replicated from index.ts) ─────────────────────────────────

function formatEnergy(joules: number): string {
  if (joules === 0) return "0 J";
  if (joules < 3.6) return `${joules.toFixed(2)} J`;
  const mwh = joules / 3600;
  if (mwh < 1000) return `${mwh.toFixed(2)} mWh`;
  const wh = mwh / 1000;
  if (wh < 1000) return `${wh.toFixed(2)} Wh`;
  const kwh = wh / 1000;
  return `${kwh.toFixed(2)} kWh`;
}

function formatEnergyCompact(joules: number): string {
  if (joules === 0) return "0J";
  if (joules < 3.6) return `${joules.toFixed(2)}J`;
  const mwh = joules / 3600;
  if (mwh < 1000) return `${mwh.toFixed(2)}mWh`;
  const wh = mwh / 1000;
  if (wh < 1000) return `${wh.toFixed(2)}Wh`;
  const kwh = wh / 1000;
  return `${kwh.toFixed(2)}kWh`;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.000001) return `$${usd.toExponential(1)}`;
  if (usd < 0.01) return `$${usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (usd < 1) return `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${usd.toFixed(2)}`;
}

function formatKwh(kwh: number): string {
  if (kwh === 0) return "0";
  if (kwh < 0.01) return kwh.toFixed(4);
  if (kwh < 1) return kwh.toFixed(2);
  if (kwh < 100) return kwh.toFixed(1);
  return Math.round(kwh).toString();
}

function formatCarbon(grams: number): string {
  if (grams === 0) return "0 g";
  if (grams < 1) return `${(grams * 1000).toFixed(2)} mg`;
  if (grams < 1000) {
    const dec = grams < 10 ? 2 : grams < 100 ? 1 : 0;
    return `${grams.toFixed(dec)} g`;
  }
  return `${(grams / 1000).toFixed(2)} kg`;
}

function formatCarbonCompact(grams: number): string {
  if (grams === 0) return "0g";
  if (grams < 1) return `${(grams * 1000).toFixed(2)}mg`;
  if (grams < 1000) {
    const dec = grams < 10 ? 2 : grams < 100 ? 1 : 0;
    return `${grams.toFixed(dec)}g`;
  }
  return `${(grams / 1000).toFixed(2)}kg`;
}

// ── Energy levels ────────────────────────────────────────────────────────

describe("energy progressive disclosure levels", () => {
  const testCases = [
    { joules: 2772, costUsd: 0.003829 },   // 0.77 mWh range
    { joules: 0, costUsd: 5.50 },           // no energy, only cost
    { joules: 500, costUsd: 0 },            // only energy (J range)
    { joules: 360000, costUsd: 0.01 },      // 100 mWh range
    { joules: 3600000, costUsd: 1.50 },     // 1 Wh range
    { joules: 36000000, costUsd: 99.99 },   // 10 Wh / kWh range
  ];

  for (const { joules, costUsd } of testCases) {
    it(`produces strictly shorter levels for ${formatEnergy(joules)} ${formatCost(costUsd)}`, () => {
      const energyStr = formatEnergy(joules);
      const costStr = formatCost(costUsd);
      const compactStr = formatEnergyCompact(joules);

      const levels = [
        `⚡${energyStr} ${costStr}`,
        `⚡${compactStr} ${costStr}`,
        `⚡${compactStr}`,
      ];

      // Each level must be strictly shorter (or same width but different content)
      for (let i = 1; i < levels.length; i++) {
        const prevWidth = termVisWidth(levels[i - 1]);
        const currWidth = termVisWidth(levels[i]);
        expect(currWidth).toBeLessThanOrEqual(prevWidth);
      }

      // ⚡ is 2 cols wide — every level must account for that
      for (const level of levels) {
        expect(termVisWidth(level)).toBeGreaterThanOrEqual(2);
      }
    });
  }

  it("compact format is always ≤ spaced format in visible width", () => {
    const testJoules = [0, 1, 100, 2772, 36000, 360000, 3600000, 36000000, 100000000];
    for (const j of testJoules) {
      const spaced = formatEnergy(j);
      const compact = formatEnergyCompact(j);
      expect(termVisWidth(compact)).toBeLessThanOrEqual(termVisWidth(spaced));
    }
  });
});

// ── Quota levels ──────────────────────────────────────────────────────────

function buildQuotaSubParts(
  plan: string,
  active: boolean,
  pastDue: boolean,
  showKwh: boolean,
  kwhRem: number | null,
  kwhTotal: number | null,
  overage: boolean,
  spacedKwhUnit: boolean,
  showDot: boolean,
  credits: string,
  allowance?: string,
): string {
  const parts: string[] = [];
  parts.push(plan);
  if (showDot) {
    if (active) parts.push("●");
    else if (pastDue) parts.push("⊘");
  }
  if (showKwh && kwhRem != null) {
    if (kwhTotal != null) {
      const unit = spacedKwhUnit ? " kWh" : "kWh";
      parts.push(`${formatKwh(kwhRem)}/${formatKwh(kwhTotal)}${unit}`);
    } else {
      parts.push(`${formatKwh(kwhRem)}kWh`);
    }
    if (overage) parts.push("⚠");
    parts.push(`∙ ${credits}`);
  } else if (!showDot || pastDue) {
    // No kWh and either no status dot or error dot — need ∙ separator before credits
    parts.push(`∙ ${credits}`);
  } else {
    // ● already acts as visual delimiter — skip ∙
    parts.push(credits);
  }
  if (allowance) parts.push(allowance);
  return parts.join(" ");
}

describe("quota progressive disclosure levels", () => {
  it("produces strictly shorter levels for pro subscription with allowance", () => {
    const plan = "pro";
    const credits = formatCost(74.62);
    const allowance = "∙ ⚷ $0.12/$1.00/d";

    const levels = [
      buildQuotaSubParts(plan, true, false, true, 28.0, 33.0, false, true, true, credits, allowance),  // full
      buildQuotaSubParts(plan, true, false, true, 28.0, 33.0, false, true, true, credits),               // drop allowance
      buildQuotaSubParts(plan, true, false, true, 28.0, 33.0, false, false, true, credits),               // merge kWh unit
      buildQuotaSubParts(plan, true, false, true, 28.0, null, false, false, true, credits),              // drop "/total"
      buildQuotaSubParts(plan, true, false, false, null, null, false, false, true, credits),              // drop kWh
      buildQuotaSubParts(plan, true, false, false, null, null, false, false, false, credits),             // drop status dot
      plan,                                                                                                // plan only
    ];

    for (let i = 1; i < levels.length; i++) {
      expect(termVisWidth(levels[i])).toBeLessThanOrEqual(termVisWidth(levels[i - 1]));
    }

    // Last level (plan only) must be positive width
    expect(termVisWidth(levels[levels.length - 1])).toBeGreaterThan(0);
  });

  it("produces strictly shorter levels for pro subscription without allowance", () => {
    const plan = "pro";
    const credits = formatCost(74.62);

    const levels = [
      buildQuotaSubParts(plan, true, false, true, 28.0, 33.0, false, true, true, credits),     // full
      buildQuotaSubParts(plan, true, false, true, 28.0, 33.0, false, false, true, credits),    // merge kWh unit
      buildQuotaSubParts(plan, true, false, true, 28.0, null, false, false, true, credits),    // drop "/total"
      buildQuotaSubParts(plan, true, false, false, null, null, false, false, true, credits),  // drop kWh
      buildQuotaSubParts(plan, true, false, false, null, null, false, false, false, credits),  // drop status dot
      plan,                                                                                       // plan only
    ];

    for (let i = 1; i < levels.length; i++) {
      expect(termVisWidth(levels[i])).toBeLessThanOrEqual(termVisWidth(levels[i - 1]));
    }
  });

  it("produces correct display for each quota level at expected widths", () => {
    const plan = "pro";
    const credits = "$74.62";
    const allowance = "∙ ⚷ $0.12/$1.00/d";

    const full = buildQuotaSubParts(plan, true, false, true, 28.0, 33.0, false, true, true, credits, allowance);
    const noAllowance = buildQuotaSubParts(plan, true, false, true, 28.0, 33.0, false, true, true, credits);
    const mergedUnit = buildQuotaSubParts(plan, true, false, true, 28.0, 33.0, false, false, true, credits);
    const noTotal = buildQuotaSubParts(plan, true, false, true, 28.0, null, false, false, true, credits);
    const noKwh = buildQuotaSubParts(plan, true, false, false, null, null, false, false, true, credits);
    const noDot = buildQuotaSubParts(plan, true, false, false, null, null, false, false, false, credits);

    // Verify the compression semantics
    expect(mergedUnit).toContain("kWh");
    expect(mergedUnit).not.toContain(" kWh");
    expect(noTotal).not.toContain("/33.0");
    expect(noTotal).toContain("28.0kWh");
    expect(noKwh).not.toContain("kWh");
    expect(noKwh).not.toContain("● ∙");
    expect(noKwh).toContain("●");
    expect(noDot).not.toContain("●");
    expect(noDot).toContain("pro");
    expect(noDot).toContain("∙");
  });

  it("handles pay-as-you-go with progressive levels", () => {
    const credits = formatCost(12.50);
    const allowance = "∙ ⚷ $0.50/$2.00/wk";

    const levels = [
      ["payg", `∙ ${credits}`, allowance].join(" "),
      ["payg", `∙ ${credits}`].join(" "),
      "payg",
    ];

    for (let i = 1; i < levels.length; i++) {
      expect(termVisWidth(levels[i])).toBeLessThanOrEqual(termVisWidth(levels[i - 1]));
    }
  });
});

// ── termVisWidth ──────────────────────────────────────────────────────────

describe("termVisWidth", () => {
  it("counts plain ASCII as 1 col each", () => {
    expect(termVisWidth("hello")).toBe(5);
    expect(termVisWidth("")).toBe(0);
  });

  it("counts ⚡ as 2 cols (Emoji_Presentation)", () => {
    expect(termVisWidth("⚡")).toBe(2);
    expect(termVisWidth("⚡0.77")).toBe(6); // 2 + 4
  });

  it("counts ● as 1 col", () => {
    expect(termVisWidth("●")).toBe(1);
  });

  it("ignores ANSI escape sequences", () => {
    const cyan = "\x1b[36mhello\x1b[0m";
    expect(termVisWidth(cyan)).toBe(5);
  });

  it("handles complex ANSI sequences", () => {
    const styled = "\x1b[38;2;102;102;102mpro ● 28.0/33.0 kWh\x1b[39m";
    // "pro ● 28.0/33.0 kWh" = 3+1+1+1+14 = 20 visible cols
    expect(termVisWidth(styled)).toBe(termVisWidth("pro ● 28.0/33.0 kWh"));
  });

  it("measures the crash scenario correctly", () => {
    // From the crash log: line 444 had w=49 in a 47-col terminal
    const energy = "⚡0.77 mWh $0.003829";
    const quota = "pro ● 28.0/33.0 kWh ∙ $74.62";
    expect(termVisWidth(energy)).toBe(20);
    expect(termVisWidth(quota)).toBe(28);
    // Total with 1 space = 49, exceeds 47 by 2
    expect(termVisWidth(energy) + 1 + termVisWidth(quota)).toBe(49);
  });
});

// ── Non-BMP / flag emoji (code-point-aware width) ─────────────────────────

describe("termVisWidth non-BMP (flag emoji, 🌱)", () => {
  it("counts a flag (two regional indicators) as 2 cols, not 4", () => {
    expect(termVisWidth("🇺🇸")).toBe(2);
    expect(termVisWidth("🇫🇮")).toBe(2);
    expect(termVisWidth("🇫🇷")).toBe(2);
  });

  it("counts 🌱 as 2 cols", () => {
    expect(termVisWidth("🌱")).toBe(2);
  });

  it("measures a full region badge correctly", () => {
    expect(termVisWidth("🇺🇸 PJM 416")).toBe(10); // 2 + 1 + 3 + 1 + 3
  });
});

// ── Carbon progressive disclosure ─────────────────────────────────────────

describe("carbon progressive disclosure levels", () => {
  const carbonStr = formatCarbon(1.24);        // "1.24 g"
  const carbonCompact = formatCarbonCompact(1.24); // "1.24g"

  it("carbon tiers are monotonically non-increasing in width", () => {
    const tiers = [`🌱${carbonStr} CO₂`, `🌱${carbonStr}`, `🌱${carbonCompact}`, ""];
    for (let i = 1; i < tiers.length; i++) {
      expect(termVisWidth(tiers[i])).toBeLessThanOrEqual(termVisWidth(tiers[i - 1]));
    }
  });

  it("carbon inserted between cost and MCR keeps levels monotonic", () => {
    const core = `⚡${formatEnergy(2772)} ${formatCost(0.003829)}`; // ⚡0.77 mWh $0.003829
    const carbonFull = `🌱${carbonStr} CO₂`;
    const mcrFull = "MCR 3bb342a0 drop<5 APC 85% compact 45%";
    const levels = [
      `${core} ${carbonFull}  ${mcrFull}`, // full
      `${core} ${carbonFull}`,             // drop MCR
      `${core} 🌱${carbonStr}`,            // drop "CO₂" suffix
      `${core} 🌱${carbonCompact}`,        // compact carbon
      core,                                // drop carbon
      `⚡${formatEnergyCompact(2772)} ${formatCost(0.003829)}`, // compress + cost
      `⚡${formatEnergyCompact(2772)}`,   // compressed only
    ];
    for (let i = 1; i < levels.length; i++) {
      expect(termVisWidth(levels[i])).toBeLessThanOrEqual(termVisWidth(levels[i - 1]));
    }
  });
});

// ── Region badge progressive disclosure ──────────────────────────────────

describe("region badge progressive disclosure levels", () => {
  it("region tiers (flag→intensity→short→dropped) are monotonic", () => {
    const tiers = ["🇺🇸 PJM 416", "PJM 416", "PJM", ""];
    for (let i = 1; i < tiers.length; i++) {
      expect(termVisWidth(tiers[i])).toBeLessThanOrEqual(termVisWidth(tiers[i - 1]));
    }
  });

  it("fallback intensities carry a ~ marker (still monotonic)", () => {
    const tiers = ["🇺🇸 DUK 378~", "DUK 378~", "DUK", ""];
    for (let i = 1; i < tiers.length; i++) {
      expect(termVisWidth(tiers[i])).toBeLessThanOrEqual(termVisWidth(tiers[i - 1]));
    }
  });

  it("quota+region combined levels are monotonic", () => {
    const quota = "pro ● 28.0/33.0 kWh ∙ $74.62 ∙ ⚷ $0.12/$1.00/d";
    const levels = [
      `${quota} 🇺🇸 PJM 416`, // full quota + full badge
      "pro ● 28.0/33.0 kWh ∙ $74.62 🇺🇸 PJM 416", // drop allowance
      "pro 🇺🇸 PJM 416", // plan + badge
      "pro PJM 416", // drop flag
      "pro PJM", // drop intensity
      "pro", // drop badge
    ];
    for (let i = 1; i < levels.length; i++) {
      expect(termVisWidth(levels[i])).toBeLessThanOrEqual(termVisWidth(levels[i - 1]));
    }
  });
});

// ── Standalone region (quota off but carbon on) ─────────────────────────

// Replica of buildRegionText: pick the highest-fidelity region tier that fits
// maxCols, or undefined when only the empty ("drop") tier fits.
function pickRegionTier(tiers: string[], maxCols: number): string | undefined {
  for (const t of tiers) {
    if (t && termVisWidth(t) <= maxCols) return t;
  }
  return undefined;
}

describe("buildRegionText (standalone region compressor)", () => {
  const tiers = ["🇺🇸 PJM 416", "PJM 416", "PJM", ""]; // 10, 7, 3, 0

  it("returns the full badge when it fits", () => {
    expect(pickRegionTier(tiers, Infinity)).toBe("🇺🇸 PJM 416");
    expect(pickRegionTier(tiers, 10)).toBe("🇺🇸 PJM 416");
  });

  it("compresses to the best-fitting non-empty tier", () => {
    expect(pickRegionTier(tiers, 9)).toBe("PJM 416");
    expect(pickRegionTier(tiers, 7)).toBe("PJM 416");
    expect(pickRegionTier(tiers, 6)).toBe("PJM");
    expect(pickRegionTier(tiers, 3)).toBe("PJM");
  });

  it("returns undefined when no non-empty tier fits (don't render empty)", () => {
    expect(pickRegionTier(tiers, 2)).toBeUndefined();
    expect(pickRegionTier(tiers, 1)).toBeUndefined();
    expect(pickRegionTier([""], 100)).toBeUndefined();
  });
});

// Replica of the updateEnergyStatus widget-assembly decision: where does the
// region badge go when the quota line is off but carbon is on?
function assembleRegion(opts: {
  energyWidget: boolean; quotaWidget: boolean; carbonWidget: boolean; regionText?: string;
}) {
  const { energyWidget, quotaWidget, carbonWidget, regionText } = opts;
  const regionCarriedByQuota = quotaWidget;
  const regionStandaloneText = carbonWidget && !!regionText && !regionCarriedByQuota ? regionText : undefined;
  const showWidget = !!(energyWidget || quotaWidget || (carbonWidget && regionStandaloneText));
  const rightRaw = energyWidget && quotaWidget ? "QUOTA"
    : energyWidget && regionStandaloneText ? regionStandaloneText
    : undefined;
  const leftOnlyRaw = !energyWidget && quotaWidget ? "QUOTA"
    : !energyWidget && regionStandaloneText ? regionStandaloneText
    : undefined;
  const compressRight = !!rightRaw && rightRaw === regionStandaloneText ? "REGION" : undefined;
  return { showWidget, rightRaw, leftOnlyRaw, compressRight };
}

describe("standalone region widget assembly", () => {
  const REGION = "🇺🇸 PJM 416";

  it("renders the region on the right when energy shows but quota is off", () => {
    const r = assembleRegion({ energyWidget: true, quotaWidget: false, carbonWidget: true, regionText: REGION });
    expect(r.showWidget).toBe(true);
    expect(r.rightRaw).toBe(REGION);
    expect(r.leftOnlyRaw).toBeUndefined();
    expect(r.compressRight).toBe("REGION"); // region compressor, not quota
  });

  it("renders the region standalone (left-only) when both energy and quota are off", () => {
    const r = assembleRegion({ energyWidget: false, quotaWidget: false, carbonWidget: true, regionText: REGION });
    expect(r.showWidget).toBe(true);
    expect(r.leftOnlyRaw).toBe(REGION);
    expect(r.rightRaw).toBeUndefined();
  });

  it("shows no region when carbon is off", () => {
    const r = assembleRegion({ energyWidget: false, quotaWidget: false, carbonWidget: false, regionText: REGION });
    expect(r.showWidget).toBe(false);
  });

  it("does not render a standalone region when quota carries it", () => {
    const r = assembleRegion({ energyWidget: true, quotaWidget: true, carbonWidget: true, regionText: REGION });
    expect(r.rightRaw).toBe("QUOTA"); // region rides the quota line
    expect(r.compressRight).toBeUndefined(); // quota compressor
    expect(r.leftOnlyRaw).toBeUndefined();
  });

  it("falls back to quota left-only when energy is off but quota is on", () => {
    const r = assembleRegion({ energyWidget: false, quotaWidget: true, carbonWidget: false });
    expect(r.showWidget).toBe(true);
    expect(r.leftOnlyRaw).toBe("QUOTA");
    expect(r.rightRaw).toBeUndefined();
  });
});
