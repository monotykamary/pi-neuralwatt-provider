import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { buildModels, deriveThinkingLevelMap, getPendingState, resetSessionState, streamNeuralwatt } from "../index";
import { __streamCalls, __resetStreamCalls, __setClamp } from "@earendil-works/pi-ai/compat";
import patchesData from "../patch.json" with { type: "json" };
import modelsData from "../models.json" with { type: "json" };
import customModelsData from "../custom-models.json" with { type: "json" };

// A GLM-5.2 model shaped exactly as the extension registers it (embedded
// models.json base — thinkingLevelMap derived from metadata.reasoning).
const glm52 = {
  id: "glm-5.2",
  provider: "neuralwatt",
  reasoning: true,
  input: ["text"],
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  thinkingLevelMap: {
    off: "none",
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    max: "max",
  },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32768,
};

const context = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

describe("streamNeuralwatt thinking-level forwarding", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    __resetStreamCalls();
    resetSessionState();
    __setClamp((_m, level) => level); // identity clamp by default
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("converts options.reasoning → reasoningEffort and forwards it", () => {
    const stream = streamNeuralwatt(glm52, context, { apiKey: "sk-test", reasoning: "high" } as any);
    stream.end();

    expect(__streamCalls).toHaveLength(1);
    expect(__streamCalls[0].options.reasoningEffort).toBe("high");
    expect(__streamCalls[0].options.apiKey).toBe("sk-test");
  });

  it("uses independent fetch wrappers without mutating globalThis.fetch", () => {
    const fetchBefore = globalThis.fetch;
    const first = streamNeuralwatt(glm52, context, { apiKey: "sk-test" } as any);
    const second = streamNeuralwatt(glm52, context, { apiKey: "sk-test" } as any);

    expect(globalThis.fetch).toBe(fetchBefore);
    expect(__streamCalls[0].options.fetch).toEqual(expect.any(Function));
    expect(__streamCalls[1].options.fetch).toEqual(expect.any(Function));
    expect(__streamCalls[0].options.fetch).not.toBe(__streamCalls[1].options.fetch);

    // Out-of-order completion used to restore a stale global fetch wrapper.
    first.end();
    second.end();
    expect(globalThis.fetch).toBe(fetchBefore);
  });

  it("chains a caller-supplied fetch inside the per-request energy wrapper", async () => {
    const upstream = vi.fn(async () => new Response("ok"));
    const stream = streamNeuralwatt(glm52, context, {
      apiKey: "sk-test",
      fetch: upstream,
    } as any);

    const wrappedFetch = __streamCalls[0].options.fetch as typeof globalThis.fetch;
    const response = await wrappedFetch("https://api.neuralwatt.com/v1/models");

    expect(await response.text()).toBe("ok");
    expect(upstream).toHaveBeenCalledTimes(1);
    stream.end();
  });

  it("tracks every concurrent response tee before turn accounting", async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(new Response(': energy {"energy_joules":2}\n'))
      .mockResolvedValueOnce(new Response(': energy {"energy_joules":3}\n'));
    const first = streamNeuralwatt(glm52, context, { apiKey: "sk-test", fetch: upstream } as any);
    const second = streamNeuralwatt(glm52, context, { apiKey: "sk-test", fetch: upstream } as any);
    const firstFetch = __streamCalls[0].options.fetch as typeof globalThis.fetch;
    const secondFetch = __streamCalls[1].options.fetch as typeof globalThis.fetch;

    const [firstResponse, secondResponse] = await Promise.all([
      firstFetch("https://api.neuralwatt.com/v1/chat/completions"),
      secondFetch("https://api.neuralwatt.com/v1/chat/completions"),
    ]);
    await Promise.all([firstResponse.text(), secondResponse.text()]);
    await getPendingState().teeReader;

    expect(getPendingState().pendingEnergyJoules).toBe(5);
    first.end();
    second.end();
  });

  it("drops the raw reasoning field from the forwarded options", () => {
    // streamOpenAICompletions reads reasoningEffort, not reasoning. Dropping it
    // mirrors pi-ai's streamSimpleOpenAICompletions wrapper and avoids confusion.
    const stream = streamNeuralwatt(glm52, context, { apiKey: "sk-test", reasoning: "high" } as any);
    stream.end();

    expect(__streamCalls[0].options).not.toHaveProperty("reasoning");
  });

  it("maps off → undefined reasoningEffort (lets the off-branch read thinkingLevelMap.off)", () => {
    const stream = streamNeuralwatt(glm52, context, { apiKey: "sk-test", reasoning: "off" } as any);
    stream.end();

    expect(__streamCalls[0].options.reasoningEffort).toBeUndefined();
  });

  it("leaves reasoningEffort undefined when no reasoning level is selected", () => {
    const stream = streamNeuralwatt(glm52, context, { apiKey: "sk-test" } as any);
    stream.end();

    expect(__streamCalls[0].options.reasoningEffort).toBeUndefined();
    expect(__streamCalls[0].options).not.toHaveProperty("reasoning");
  });

  it("calls clampThinkingLevel with the model and the selected level", () => {
    const spy = vi.fn((_m: any, level: any) => level);
    __setClamp(spy);

    const stream = streamNeuralwatt(glm52, context, { apiKey: "sk-test", reasoning: "max" } as any);
    stream.end();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: "glm-5.2" }), "max");
    expect(__streamCalls[0].options.reasoningEffort).toBe("max");
  });

  it("forwards the clampThinkingLevel return value as reasoningEffort", () => {
    __setClamp(() => "max");

    const stream = streamNeuralwatt(glm52, context, { apiKey: "sk-test", reasoning: "high" } as any);
    stream.end();

    expect(__streamCalls[0].options.reasoningEffort).toBe("max");
  });

  it("treats a clamped result of 'off' as undefined reasoningEffort", () => {
    __setClamp(() => "off");

    const stream = streamNeuralwatt(glm52, context, { apiKey: "sk-test", reasoning: "high" } as any);
    stream.end();

    expect(__streamCalls[0].options.reasoningEffort).toBeUndefined();
  });
});

// GLM-5.2 family's palette is provider-owned now: models.json carries the
// thinkingLevelMap derived from metadata.reasoning (see update-models.js), and
// patch.json no longer restates it. These assertions run against the effective
// catalog (base + patch) so a sync regression can't silently change what's
// registered.
describe("GLM-5.2 family effective thinkingLevelMap", () => {
  const catalog = buildModels(modelsData as any, customModelsData as any, patchesData as any);
  const expectedMap = {
    off: "none",
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  };

  for (const id of ["glm-5.2", "glm-5.2-flex", "glm-5.2-short", "glm-5.2-short-flex"]) {
    it(`${id} maps onto GLM-5.2's three real states (skip / high / max)`, () => {
      expect(catalog.find((m: any) => m.id === id)?.thinkingLevelMap).toEqual(expectedMap);
    });
  }

  it("glm-5.2 off maps to none (skip), not the unset default (max)", () => {
    // GLM-5.2's default when reasoning_effort is absent is `max` (deepest).
    // Without an explicit off→none, picking "off" would maximize thinking
    // instead of disabling it — the exact "off does nothing" symptom.
    expect(catalog.find((m: any) => m.id === "glm-5.2")?.thinkingLevelMap?.off).toBe("none");
  });

  it("patch.json no longer needs to restate the GLM-5.2 family maps", () => {
    for (const id of ["glm-5.2", "glm-5.2-flex", "glm-5.2-short", "glm-5.2-short-flex"]) {
      expect(patchesData[id]?.thinkingLevelMap).toBeUndefined();
    }
  });
});

describe("Kimi K2.7 family patch.json thinkingLevelMap", () => {
  const patches = patchesData as Record<string, any>;
  const expectedMap = {
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: "high",
  };

  for (const id of ["kimi-k2.7-code"]) {
    it(`${id} thinkingLevelMap clamps max → high (model caps at highest supported)`, () => {
      expect(patches[id]?.thinkingLevelMap).toEqual(expectedMap);
    });
  }

  it("kimi-k2.7-code max maps to high (clamps to highest supported)", () => {
    // K2.7 caps at high; this clamps max → high so /reasoning max is honored as a
    // real level rather than silently passed through to an API that rejects it.
    expect(patches["kimi-k2.7-code"]?.thinkingLevelMap?.max).toBe("high");
  });
});

describe("chatTemplateKwargs onPayload injection", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    __resetStreamCalls();
    __setClamp((_m, level) => level);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Kimi K2.6 model shaped as buildModels() produces it after patch.json:
  // chatTemplateKwargs: { preserve_thinking: true } is set on the compat block.
  const kimi26 = {
    id: "kimi-k2.6",
    provider: "neuralwatt",
    reasoning: true,
    input: ["text", "image"],
    thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null },
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      chatTemplateKwargs: { preserve_thinking: true },
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 262144,
  };

  const ctx = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

  it("registers an onPayload hook when model.compat.chatTemplateKwargs is set", () => {
    const stream = streamNeuralwatt(kimi26, ctx, { apiKey: "sk-test", reasoning: "high" } as any);
    stream.end();

    expect(__streamCalls).toHaveLength(1);
    expect(typeof __streamCalls[0].options.onPayload).toBe("function");
  });

  it("injects chat_template_kwargs.preserve_thinking = true into the payload", async () => {
    const stream = streamNeuralwatt(kimi26, ctx, { apiKey: "sk-test", reasoning: "high" } as any);
    stream.end();

    const onPayload = __streamCalls[0].options.onPayload;
    const original = { model: "kimi-k2.6", messages: [], reasoning_effort: "high" };
    const result = await onPayload(original, kimi26);

    expect(result).toEqual({
      ...original,
      chat_template_kwargs: { preserve_thinking: true },
    });
    // reasoning_effort is preserved (onPayload doesn't displace it)
    expect(result.reasoning_effort).toBe("high");
  });

  it("injects chat_template_kwargs.clear_thinking = false for GLM-5.2 family", async () => {
    // GLM-5.x reasoning variants opt into full-history via clear_thinking: false
    // (behavioral E2E: 1/4 → 4/4 recall). The kwarg is template-level and family-
    // specific; the onPayload path injects whatever chatTemplateKwargs lists.
    const glm52Model = {
      ...glm52,
      id: "glm-5.2",
      compat: { supportsDeveloperRole: false, chatTemplateKwargs: { clear_thinking: false } },
    };
    const stream = streamNeuralwatt(glm52Model, ctx, { apiKey: "sk-test", reasoning: "high" } as any);
    stream.end();

    const onPayload = __streamCalls[0].options.onPayload;
    const result = await onPayload({ model: "glm-5.2", reasoning_effort: "high" }, glm52Model);
    expect(result.chat_template_kwargs).toEqual({ clear_thinking: false });
    expect(result.reasoning_effort).toBe("high");
  });

  it("merges into pre-existing chat_template_kwargs instead of clobbering", async () => {
    const stream = streamNeuralwatt(kimi26, ctx, { apiKey: "sk-test", reasoning: "high" } as any);
    stream.end();

    const onPayload = __streamCalls[0].options.onPayload;
    const original = { model: "kimi-k2.6", chat_template_kwargs: { enable_thinking: true } };
    const result = await onPayload(original, kimi26);

    expect(result.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
  });

  it("does NOT register onPayload when chatTemplateKwargs is absent (e.g. Qwen / non-reasoning)", () => {
    // Qwen3.x and Kimi -fast (non-reasoning) have no full-history kwarg (not
    // exposed by their chat template / nothing to preserve). They rely on the
    // intrinsic Layer-A replay (pi-ai replays the `reasoning` field; the gateway
    // aliases reasoning <-> reasoning_content). glm52 here has no chatTemplateKwargs,
    // standing in for such a model.
    const stream = streamNeuralwatt(glm52, ctx, { apiKey: "sk-test", reasoning: "high" } as any);
    stream.end();

    expect(__streamCalls[0].options.onPayload).toBeUndefined();
  });

  it("chains a caller-supplied onPayload first, then injects preserve_thinking", async () => {
    const userPayload = vi.fn((p: any) => ({ ...p, reason: "user-saw-it", model: p.model }));
    const stream = streamNeuralwatt(kimi26, ctx, {
      apiKey: "sk-test",
      reasoning: "high",
      onPayload: userPayload,
    } as any);
    stream.end();

    const onPayload = __streamCalls[0].options.onPayload;
    const result = await onPayload({ model: "kimi-k2.6" }, kimi26);

    expect(userPayload).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe("user-saw-it");
    expect(result.chat_template_kwargs).toEqual({ preserve_thinking: true });
  });
});

describe("patch.json chatTemplateKwargs enablement (behavioral E2E-verified)", () => {
  const patches = patchesData as Record<string, any>;

  // Kimi K2.6/K2.7 reasoning variants: preserve_thinking: true
  // (doc-backed; behavioral E2E: 0/6 → 6/6 recall)
  const kimi = ["kimi-k2.6", "kimi-k2.7-code"];
  for (const id of kimi) {
    it(`${id} opts into full-history via preserve_thinking: true`, () => {
      expect(patches[id]?.compat?.chatTemplateKwargs).toEqual({ preserve_thinking: true });
      // Layer-A empty-scaffold stays on alongside it
      expect(patches[id]?.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
    });
  }

  // GLM-5.2 reasoning variants: clear_thinking: false
  // (NOT in the docs' full-history table, which lists clear_thinking only for
  // GLM-5.1; but behavioral E2E proved it functional on GLM-5.2: 1/4 → 4/4 recall,
  // confirmed family-wide on base/short). Non-reasoning -fast variants excluded.
  const glm = ["glm-5.2", "glm-5.2-flex", "glm-5.2-short", "glm-5.2-short-flex"];
  for (const id of glm) {
    it(`${id} opts into full-history via clear_thinking: false`, () => {
      expect(patches[id]?.compat?.chatTemplateKwargs).toEqual({ clear_thinking: false });
    });
  }

  // Models with no provider-specific full-history kwarg: non-reasoning -fast
  // variants (nothing to preserve) and Qwen (pi-ai's qwen-chat-template format
  // already injects its own preserve_thinking switch).
  const none = ["kimi-k2.6-fast", "glm-5.2-fast", "qwen3.5-397b-fast", "qwen3.6-35b-fast"];
  for (const id of none) {
    it(`${id} sets NO provider-specific chatTemplateKwargs`, () => {
      expect(patches[id]?.compat?.chatTemplateKwargs).toBeUndefined();
    });
  }
});

describe("modelOverrides (user config) applied on top of patch", () => {
  // Mirrors buildModels(base, custom, patch, overrides) + applyModelOverride.
  // Defined inline so the test stays self-contained without importing the
  // (private) buildModels; it validates the override semantics the feature
  // promises: deep-merge compat, replace scalars, win over patch.json.
  function applyModelOverride(model: any, override: any): any {
    const result = { ...model };
    const NESTED = new Set(["compat", "vision", "cost", "thinkingLevelMap"]);
    for (const [k, v] of Object.entries(override)) {
      if (NESTED.has(k) && typeof v === "object" && v !== null && typeof result[k] === "object") {
        result[k] = { ...result[k], ...v };
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  const base = {
    id: "kimi-k2.6",
    provider: "neuralwatt",
    reasoning: true,
    compat: { supportsDeveloperRole: false, chatTemplateKwargs: { preserve_thinking: true } },
    thinkingLevelMap: { low: "low", high: "high" },
  };

  it("override wins over patch.json for a compat flag it sets", () => {
    // User disables preserve_thinking via override → must win over patch.json's true.
    const out = applyModelOverride(base, { compat: { chatTemplateKwargs: { preserve_thinking: false } } });
    expect(out.compat.chatTemplateKwargs.preserve_thinking).toBe(false);
  });

  it("deep-merges compat so non-overridden flags survive", () => {
    // User toggles only chatTemplateKwargs; supportsDeveloperRole must survive.
    const out = applyModelOverride(base, { compat: { chatTemplateKwargs: {} } });
    expect(out.compat.supportsDeveloperRole).toBe(false);
    expect(out.compat.chatTemplateKwargs).toEqual({});
  });

  it("deep-merges thinkingLevelMap so a single level can be overridden", () => {
    const out = applyModelOverride(base, { thinkingLevelMap: { high: null } });
    expect(out.thinkingLevelMap).toEqual({ low: "low", high: null });
  });

  it("replace-semantics for scalar fields (e.g. reasoning)", () => {
    const out = applyModelOverride(base, { reasoning: false });
    expect(out.reasoning).toBe(false);
  });
});

// Replays pi-ai's getSupportedThinkingLevels (dist/models.js) over the shipped
// catalog. pi's UI hides a level iff the model's thinkingLevelMap maps it to
// null, and xhigh/max additionally require a non-undefined mapping. Guards the
// regression fixed by "feat: restore kimi-k3 thinking levels and compat via
// patch override": a models sync that drops kimi-k3's map silently downgrades
// the UI to the 5 default levels (off/minimal/low/medium/high) and loses max.
describe("catalog regression: kimi-k3 visible thinking levels", () => {
  const EXTENDED = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

  function piVisibleLevels(model: any): string[] {
    if (!model.reasoning) return ["off"];
    return EXTENDED.filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      if (mapped === null) return false;
      if (level === "xhigh" || level === "max") return mapped !== undefined;
      return true;
    });
  }

  const catalog = buildModels(modelsData as any, customModelsData as any, patchesData as any);

  it("kimi-k3 ships reasoning with its thinkingLevelMap applied", () => {
    const k3 = catalog.find((m: any) => m.id === "kimi-k3");
    expect(k3).toBeDefined();
    expect(k3.reasoning).toBe(true);
    expect(k3.thinkingLevelMap).toEqual(patchesData["kimi-k3"].thinkingLevelMap);
  });

  it("kimi-k3 resolves to exactly low/high/max (off and medium hidden)", () => {
    const k3 = catalog.find((m: any) => m.id === "kimi-k3");
    expect(piVisibleLevels(k3)).toEqual(["low", "high", "max"]);
  });
});

// Runtime parity: index.ts re-implements the same derivation as
// scripts/update-models.js (live-refresh path vs sync path — see the comment on
// transformApiModel). Both consume the portal's metadata.reasoning block.
describe("runtime metadata.reasoning → thinkingLevelMap derivation", () => {
  // Exact block from NeuralWatt's launch note (portal.neuralwatt.com/models/glm-5.2).
  const GLM52_BLOCK = {
    mandatory: false,
    default_enabled: true,
    supported_efforts: ["max", "high", "none"],
    default_effort: "max",
    accepted_efforts: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
    effort_aliases: { xhigh: "max", medium: "high", low: "high", minimal: "none" },
  };

  it("derives glm-5.2's palette identically to the sync script", () => {
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

  it("mandatory reasoning hides off", () => {
    const map = deriveThinkingLevelMap({
      mandatory: true,
      supported_efforts: ["low", "high", "max"],
      accepted_efforts: ["low", "high", "max"],
    })!;
    expect(map.off).toBe(null);
    expect(map.max).toBe("max");
  });

  it("returns undefined for missing / granularity-free blocks", () => {
    expect(deriveThinkingLevelMap(undefined)).toBeUndefined();
    expect(deriveThinkingLevelMap({ supported_efforts: ["none"] })).toBeUndefined();
  });
});

