import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { streamNeuralwatt } from "../index";
import { __streamCalls, __resetStreamCalls, __setClamp } from "@earendil-works/pi-ai";
import patchesData from "../patch.json" with { type: "json" };

// A GLM-5.2 model shaped exactly as the extension registers it (embedded
// models.json base + patch.json thinkingLevelMap).
const glm52 = {
  id: "glm-5.2",
  provider: "neuralwatt",
  reasoning: true,
  input: ["text"],
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  thinkingLevelMap: {
    off: "minimal",
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: "max",
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

    const stream = streamNeuralwatt(glm52, context, { apiKey: "sk-test", reasoning: "xhigh" } as any);
    stream.end();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: "glm-5.2" }), "xhigh");
    expect(__streamCalls[0].options.reasoningEffort).toBe("xhigh");
  });

  it("forwards the clampThinkingLevel return value as reasoningEffort", () => {
    __setClamp(() => "max");

    const stream = streamNeuralwatt(glm52, context, { apiKey: "sk-test", reasoning: "xhigh" } as any);
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

describe("GLM-5.2 family patch.json thinkingLevelMap", () => {
  const patches = patchesData as Record<string, any>;
  const expectedMap = {
    off: "minimal",
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: "max",
  };

  for (const id of ["glm-5.2", "glm-5.2-flex", "glm-5.2-short"]) {
    it(`${id} maps onto GLM-5.2's three real states (skip / high / max)`, () => {
      expect(patches[id]?.thinkingLevelMap).toEqual(expectedMap);
    });
  }

  it("glm-5.2 off maps to minimal (skip), not the unset default (max)", () => {
    // GLM-5.2's default when reasoning_effort is absent is `max` (deepest).
    // Without an explicit off→minimal, picking "off" would maximize thinking
    // instead of disabling it — the exact "off does nothing" symptom.
    expect(patches["glm-5.2"]?.thinkingLevelMap?.off).toBe("minimal");
  });
});
