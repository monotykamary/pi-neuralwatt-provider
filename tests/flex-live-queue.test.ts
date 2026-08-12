import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  liveFlexElapsedSeconds,
  flexLiveTiers,
  liveFlexQueueState,
  streamNeuralwatt,
  resetSessionState,
} from "../index";

describe("liveFlexElapsedSeconds", () => {
  const t0 = 1_000_000;

  it("stays hidden inside the 2s grace window", () => {
    expect(liveFlexElapsedSeconds(t0, t0)).toBeUndefined();
    expect(liveFlexElapsedSeconds(t0, t0 + 1999)).toBeUndefined();
  });

  it("reports whole seconds from the 2s mark onward", () => {
    expect(liveFlexElapsedSeconds(t0, t0 + 2000)).toBe(2);
    expect(liveFlexElapsedSeconds(t0, t0 + 2999)).toBe(2);
    expect(liveFlexElapsedSeconds(t0, t0 + 65_000)).toBe(65);
  });
});

describe("flexLiveTiers", () => {
  it("keeps the previous turn's discount in the full tier", () => {
    expect(flexLiveTiers(125, 83)).toEqual([
      "flex −83% · queued ~2m05s",
      "flex queued ~2m05s",
      "",
    ]);
  });

  it("collapses to wait-only tiers without a previous discount", () => {
    expect(flexLiveTiers(12)).toEqual(["flex queued ~12s", ""]);
  });

  it("is strictly shorter at each disclosure level", () => {
    const tiers = flexLiveTiers(60, 7);
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i].length).toBeLessThan(tiers[i - 1].length);
    }
  });
});

describe("streamNeuralwatt live flex queue state", () => {
  const flexModel = {
    id: "glm-5.2-flex",
    provider: "neuralwatt",
    reasoning: true,
    input: ["text"],
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32768,
  };
  const context = {
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };

  beforeEach(() => {
    resetSessionState();
    expect(liveFlexQueueState()).toEqual({ streams: 0, startedAt: null });
  });

  it("marks a flex stream in flight and clears once it settles", async () => {
    const stream = streamNeuralwatt(flexModel as any, context as any, { apiKey: "sk-test" } as any);
    expect(liveFlexQueueState().streams).toBe(1);
    expect(liveFlexQueueState().startedAt).toEqual(expect.any(Number));
    // mock's inner stream auto-ends on a microtask → pump settles → onSettled
    await vi.waitFor(() => expect(liveFlexQueueState()).toEqual({ streams: 0, startedAt: null }));
  });

  it("does not mark standard-tier models", async () => {
    const standard = { ...flexModel, id: "glm-5.2" };
    const stream = streamNeuralwatt(standard as any, context as any, { apiKey: "sk-test" } as any);
    await vi.waitFor(() => expect(liveFlexQueueState()).toEqual({ streams: 0, startedAt: null }));
  });

  it("reference-counts concurrent flex streams", async () => {
    const a = streamNeuralwatt(flexModel as any, context as any, { apiKey: "sk-test" } as any);
    const b = streamNeuralwatt(flexModel as any, context as any, { apiKey: "sk-test" } as any);
    expect(liveFlexQueueState().streams).toBe(2);
    await vi.waitFor(() => expect(liveFlexQueueState()).toEqual({ streams: 0, startedAt: null }));
  });
});
