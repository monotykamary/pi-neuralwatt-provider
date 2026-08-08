import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanStalePatchEntries, updateDeprecatedModels, extractCustomPatchOverrides, mergePatchEntries, deriveThinkingLevelMap, transformModel, cleanModelForJson } from "../scripts/update-models.js";

// The sync script must keep a patch.json entry alive for exactly as long as
// its model: entries for upstream models, custom (hidden) models, AND models
// sitting in the deprecated-models.json grace period all survive cleaning;
// the entry dies in the same run that evicts the model from the graveyard.

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "update-models-test-"));
}

describe("update-models.js patch/graveyard lifetime", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps patch entries for grace-period models, drops entries for evicted/gone models", () => {
    const dir = tmpdir();
    const patchPath = path.join(dir, "patch.json");
    const patch = {
      "upstream-model": { compat: { a: 1 } },
      "custom-model": { compat: { b: 2 } },
      "graveyard-model": { compat: { c: 3 } },
      "evicted-model": { compat: { d: 4 } },
      "gone-model": { compat: { e: 5 } },
    };
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));

    const cleaned = cleanStalePatchEntries(
      patch,
      new Set(["upstream-model"]),
      new Set(["custom-model"]),
      new Set(["graveyard-model"]), // evicted-model is absent: eviction already happened
      patchPath,
    );

    expect(Object.keys(cleaned).sort()).toEqual(["custom-model", "graveyard-model", "upstream-model"]);
    expect(JSON.parse(fs.readFileSync(patchPath, "utf8"))).toEqual(cleaned);
  });

  it("reconciles the graveyard: delist adds, resurrect drops, TTL evicts, timestamp sticks", () => {
    const dir = tmpdir();
    const modelsJsonPath = path.join(dir, "models.json");
    fs.writeFileSync(
      modelsJsonPath,
      JSON.stringify([
        { id: "live-model", name: "Live" },
        { id: "delisted-model", name: "Delisted" },
      ]),
    );
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS).toISOString();
    const twentyDaysAgo = new Date(Date.now() - 20 * DAY_MS).toISOString();
    fs.writeFileSync(
      path.join(dir, "deprecated-models.json"),
      JSON.stringify({
        "grace-model": { id: "grace-model", name: "Grace", deprecatedAt: tenDaysAgo },
        "expired-model": { id: "expired-model", name: "Expired", deprecatedAt: twentyDaysAgo },
        "resurrected-model": { id: "resurrected-model", name: "Resurrected", deprecatedAt: tenDaysAgo },
      }),
    );

    const deprecated = updateDeprecatedModels(modelsJsonPath, [
      { id: "live-model", name: "Live v2" },
      { id: "resurrected-model", name: "Resurrected v2" },
    ]);

    expect(Object.keys(deprecated).sort()).toEqual(["delisted-model", "grace-model"]);
    // The grace clock is not reset on repeat runs.
    expect(deprecated["grace-model"].deprecatedAt).toBe(tenDaysAgo);
    // A newly delisted model carries its last models.json snapshot forward, stamped now-ish.
    expect(deprecated["delisted-model"].name).toBe("Delisted");
    expect(Number.isNaN(Date.parse(deprecated["delisted-model"].deprecatedAt))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "deprecated-models.json"), "utf8"))).toEqual(deprecated);
  });

  it("end-to-end lifetime: patch entry survives delisting and dies with eviction", () => {
    const dir = tmpdir();
    const modelsJsonPath = path.join(dir, "models.json");
    const patchPath = path.join(dir, "patch.json");
    fs.writeFileSync(patchPath, JSON.stringify({ "doomed-model": { compat: { x: true } } }));

    // Sync 1: the model is delisted — the graveyard gains it and its patch
    // entry must survive this very run.
    fs.writeFileSync(modelsJsonPath, JSON.stringify([{ id: "doomed-model", name: "Doomed" }]));
    let deprecated = updateDeprecatedModels(modelsJsonPath, []);
    let patch = cleanStalePatchEntries(
      { "doomed-model": { compat: { x: true } } },
      new Set(),
      new Set(),
      new Set(Object.keys(deprecated)),
      patchPath,
    );
    expect(patch["doomed-model"]).toBeDefined();

    // Sync 2: the graveyard entry has aged past the TTL while the model stayed
    // delisted — eviction and patch cleanup happen in the same run.
    fs.writeFileSync(modelsJsonPath, "[]");
    fs.writeFileSync(
      path.join(dir, "deprecated-models.json"),
      JSON.stringify({
        "doomed-model": {
          id: "doomed-model",
          name: "Doomed",
          deprecatedAt: new Date(Date.now() - 20 * DAY_MS).toISOString(),
        },
      }),
    );
    deprecated = updateDeprecatedModels(modelsJsonPath, []);
    expect(deprecated["doomed-model"]).toBeUndefined();
    patch = cleanStalePatchEntries(patch, new Set(), new Set(), new Set(Object.keys(deprecated)), patchPath);
    expect(patch["doomed-model"]).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(patchPath, "utf8"))).toEqual({});
  });
});

describe("update-models.js custom-model promotion", () => {
  it("migrates bespoke overrides to patch.json when a custom model graduates upstream", () => {
    // A custom entry: reasoning palette + a compat flag the API does not express.
    const customModel = {
      id: "deepseek-v4-flash-0731-canary",
      name: "DeepSeek V4 Flash 0731 (Canary)",
      reasoning: true,
      cost: { input: 0.104, output: 0.207, cacheRead: 0.026, cacheWrite: 0 },
      thinkingLevelMap: { minimal: null, low: "low", medium: "high", high: "high", max: "max" },
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true,
      },
    };

    // Upstream now serves it, with owned pricing + a compat subset it expresses.
    const upstreamModel = {
      id: "deepseek-v4-flash-0731-canary",
      name: "DeepSeek V4 Flash (0731 Canary)",
      reasoning: true,
      cost: { input: 0.14, output: 0.28, cacheRead: 0.035, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
    };

    const override = extractCustomPatchOverrides(customModel, upstreamModel);

    // pricing is upstream-owned → NOT migrated; the API-absent compat flag +
    // thinkingLevelMap (never in the API) → migrated.
    expect(override).toEqual({
      thinkingLevelMap: { minimal: null, low: "low", medium: "high", high: "high", max: "max" },
      compat: { requiresReasoningContentOnAssistantMessages: true },
    });
  });

  it("merges into an existing patch entry without clobbering it", () => {
    const existing = { compat: { foo: 1 } };
    const incoming = {
      compat: { requiresReasoningContentOnAssistantMessages: true },
      thinkingLevelMap: { max: "max" },
    };
    const merged = mergePatchEntries(existing, incoming);
    expect(merged).toEqual({
      compat: { foo: 1, requiresReasoningContentOnAssistantMessages: true },
      thinkingLevelMap: { max: "max" },
    });
  });

  it("returns undefined when nothing bespoke needs migrating", () => {
    const customModel = {
      id: "m",
      name: "M",
      reasoning: true,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false },
    };
    const upstreamModel = {
      id: "m",
      name: "M",
      reasoning: true,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false },
    };
    expect(extractCustomPatchOverrides(customModel, upstreamModel)).toBeUndefined();
  });
});

describe("update-models.js metadata.reasoning → thinkingLevelMap derivation", () => {
  // The exact block shape the NeuralWatt portal now serves (from Joey's launch
  // note: https://portal.neuralwatt.com/models/glm-5.2).
  const GLM52_BLOCK = {
    mandatory: false,
    default_enabled: true,
    supported_efforts: ["max", "high", "none"],
    default_effort: "max",
    accepted_efforts: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
    effort_aliases: { xhigh: "max", medium: "high", low: "high", minimal: "none" },
  };

  it("derives glm-5.2's palette: canonical levels visible, alias-only levels hidden", () => {
    expect(deriveThinkingLevelMap(GLM52_BLOCK)).toEqual({
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
  });

  it("mandatory reasoning hides off (kimi-k3 shape)", () => {
    const map = deriveThinkingLevelMap({
      mandatory: true,
      default_enabled: true,
      supported_efforts: ["low", "high", "max"],
      default_effort: "high",
      accepted_efforts: ["low", "high", "max"],
      effort_aliases: {},
    });
    expect(map).toEqual({ off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
  });

  it("falls back to accepted_efforts for a native none (off → 'none')", () => {
    const map = deriveThinkingLevelMap({
      mandatory: false,
      default_enabled: true,
      supported_efforts: ["high"],
      accepted_efforts: ["high", "none"],
    });
    expect(map).toEqual({ off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null });
  });

  it("omits the off key when disabled by default and no none effort exists (omit = off)", () => {
    const map = deriveThinkingLevelMap({
      mandatory: false,
      default_enabled: false,
      supported_efforts: ["high"],
      accepted_efforts: ["high"],
    });
    expect(map).toBeDefined();
    expect("off" in map!).toBe(false);
    expect(map!.high).toBe("high");
  });

  it("hides off when enabled by default with no way to disable", () => {
    const map = deriveThinkingLevelMap({
      mandatory: false,
      default_enabled: true,
      supported_efforts: ["high"],
      accepted_efforts: ["high"],
    });
    expect(map!.off).toBe(null);
  });

  it("deepseek-like alias-only medium stays hidden (clamp resolves it up to high)", () => {
    const map = deriveThinkingLevelMap({
      mandatory: false,
      default_enabled: true,
      supported_efforts: ["none", "low", "high", "max"],
      accepted_efforts: ["none", "low", "medium", "high", "max"],
      effort_aliases: { medium: "high" },
    });
    expect(map).toEqual({ off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
  });

  it("returns undefined for missing or boolean-only reasoning blocks", () => {
    expect(deriveThinkingLevelMap(undefined)).toBeUndefined();
    expect(deriveThinkingLevelMap(null)).toBeUndefined();
    expect(deriveThinkingLevelMap({})).toBeUndefined();
    expect(deriveThinkingLevelMap({ supported_efforts: ["none"] })).toBeUndefined();
    expect(deriveThinkingLevelMap({ supported_efforts: ["default", "auto"] })).toBeUndefined();
    expect(deriveThinkingLevelMap({ supported_efforts: "high" })).toBeUndefined();
  });

  it("skips migrating a custom thinkingLevelMap that matches the API-derived one", () => {
    const mapFromBlock = deriveThinkingLevelMap(GLM52_BLOCK)!;
    const custom = {
      id: "m",
      name: "M",
      reasoning: true,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      // Same map, deliberately shuffled key order — migration must be suppressed.
      thinkingLevelMap: Object.fromEntries(Object.entries(mapFromBlock).reverse()),
    };
    const upstream = {
      id: "m",
      name: "M",
      reasoning: true,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: mapFromBlock,
    };
    expect(extractCustomPatchOverrides(custom, upstream)).toBeUndefined();
  });

  it("transformModel wires metadata.reasoning into the catalog entry", () => {
    const apiModel = {
      id: "glm-5.2",
      metadata: {
        display_name: "GLM 5.2",
        pricing: { input_per_million: 1, output_per_million: 2 },
        capabilities: { reasoning: true, reasoning_effort: true, vision: false },
        limits: { max_context_length: 200000, max_output_tokens: 131072 },
        reasoning: GLM52_BLOCK,
      },
    };
    const model = transformModel(apiModel);
    expect(model.thinkingLevelMap).toEqual({
      off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max",
    });
    expect(model.compat).toEqual({ supportsReasoningEffort: true });
    // cleanModelForJson must not strip the derived map from models.json output.
    expect(cleanModelForJson(model).thinkingLevelMap).toEqual(model.thinkingLevelMap);
  });

  it("transformModel leaves thinkingLevelMap off non-reasoning models", () => {
    const model = transformModel({
      id: "plain",
      metadata: { capabilities: { reasoning: false }, reasoning: { supported_efforts: ["high"] } },
    });
    expect(model.reasoning).toBe(false);
    expect("thinkingLevelMap" in model).toBe(false);
  });

  it("still migrates a custom thinkingLevelMap that deviates from the API-derived one", () => {
    const custom = {
      id: "m",
      name: "M",
      reasoning: true,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { minimal: null, low: "low", medium: "high", high: "high", max: "max" },
    };
    const upstream = {
      id: "m",
      name: "M",
      reasoning: true,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: deriveThinkingLevelMap(GLM52_BLOCK),
    };
    expect(extractCustomPatchOverrides(custom, upstream)).toEqual({
      thinkingLevelMap: custom.thinkingLevelMap,
    });
  });
});

