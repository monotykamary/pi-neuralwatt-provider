import { describe, expect, it, beforeEach } from "vitest";
import {
  readEnergyFromTee,
  resetSessionState,
  getPendingState,
  estimateFlexDiscount,
} from "../index";

function str(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      if (chunks.length === 0) {
        controller.close();
      } else {
        controller.enqueue(chunks.shift()!);
      }
    },
  });
}

// Queue heartbeat shape observed live: empty delta, no service_tier, no usage,
// every ~10s while a flex request is held server-side.
const heartbeat = (created: number, model = "glm-5.2-short-flex") =>
  str(
    `data: {"id": "q", "object": "chat.completion.chunk", "created": ${created}, "model": "${model}", "choices": [{"index": 0, "delta": {}, "finish_reason": null}]}\n\n`,
  );

const contentChunk = (created: number, model: string, tier: string) =>
  str(
    `data: {"id": "q", "object": "chat.completion.chunk", "created": ${created}, "model": "${model}", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "OK"}, "logprobs": null, "finish_reason": null, "token_ids": null}], "service_tier": "${tier}"}\n\n`,
  );

const usageChunk = (created: number, model: string, tier: string, prompt: number, completion: number) =>
  str(
    `data: {"id": "q", "object": "chat.completion.chunk", "created": ${created}, "model": "${model}", "choices": [], "usage": {"prompt_tokens": ${prompt}, "total_tokens": ${prompt + completion}, "completion_tokens": ${completion}, "prompt_tokens_details": {"cached_tokens": 0, "created_cache_tokens": 0}}, "system_fingerprint": "vllm-test", "service_tier": "${tier}"}\n\n`,
  );

describe("flex telemetry capture from SSE data chunks", () => {
  beforeEach(() => {
    resetSessionState();
  });

  it("detects a queued flex stream: heartbeats, tier, queue wait, usage", async () => {
    // Mirrors the live glm-5.2-short-flex capture: ~6 minutes of heartbeat
    // chunks (created advancing by ~10s), then generation starts instantly.
    const chunks = [
      heartbeat(100),
      heartbeat(110),
      heartbeat(120),
      contentChunk(160, "glm-5.2-short-flex", "flex"),
      usageChunk(161, "glm-5.2-short-flex", "flex", 14, 46),
      str(": energy {\"energy_joules\":2.68,\"duration_seconds\":0.561}\n"),
      str(": cost {\"request_cost_usd\":4e-06}\n"),
      str("data: [DONE]\n\n"),
    ];

    await readEnergyFromTee(makeStream(chunks));

    const state = getPendingState();
    expect(state.pendingServiceTier).toBe("flex");
    // First content chunk created 160 − first heartbeat created 100.
    expect(state.pendingQueueSeconds).toBe(60);
    expect(state.pendingUsage).toEqual({ prompt: 14, completion: 46, cachedInput: 0 });
    expect(state.pendingEnergyJoules).toBe(2.68);
    expect(state.pendingCostUsd).toBe(4e-06);
  });

  it("non-queued flex stream: tier captured, no queue wait", async () => {
    const chunks = [
      contentChunk(50, "deepseek-v4-flash-flex", "flex"),
      usageChunk(51, "deepseek-v4-flash-flex", "flex", 14, 132),
      str(": energy {\"energy_joules\":0.9}\n"),
      str(": cost {\"request_cost_usd\":1.6e-05}\n"),
      str("data: [DONE]\n\n"),
    ];

    await readEnergyFromTee(makeStream(chunks));

    const state = getPendingState();
    expect(state.pendingServiceTier).toBe("flex");
    expect(state.pendingQueueSeconds).toBeUndefined();
    expect(state.pendingUsage).toEqual({ prompt: 14, completion: 132, cachedInput: 0 });
  });

  it("standard-tier stream: service_tier captured, queue fields stay empty", async () => {
    const chunks = [
      contentChunk(50, "deepseek-v4-flash", "standard"),
      usageChunk(51, "deepseek-v4-flash", "standard", 14, 128),
      str(": cost {\"request_cost_usd\":4.5e-05}\n"),
      str("data: [DONE]\n\n"),
    ];

    await readEnergyFromTee(makeStream(chunks));

    const state = getPendingState();
    expect(state.pendingServiceTier).toBe("standard");
    expect(state.pendingQueueSeconds).toBeUndefined();
  });

  it("a late empty-delta finish chunk is not mistaken for a heartbeat", async () => {
    const chunks = [
      contentChunk(50, "glm-5.2-flex", "flex"),
      str('data: {"id": "q", "created": 55, "choices": [{"index": 0, "delta": {}, "logprobs": null, "finish_reason": "length", "token_ids": null}], "service_tier": "flex"}\n\n'),
      usageChunk(56, "glm-5.2-flex", "flex", 17, 64),
      str("data: [DONE]\n\n"),
    ];

    await readEnergyFromTee(makeStream(chunks));

    const state = getPendingState();
    expect(state.pendingQueueSeconds).toBeUndefined();
  });
});

describe("estimateFlexDiscount", () => {
  const deepseekCost = { input: 0.14, output: 0.28, cacheRead: 0.028 };
  const glmCost = { input: 1.45, output: 4.5, cacheRead: 0.145 };

  it("deepseek pair: charged 1.6e-5 for 14/146 tokens → ~63% off list", async () => {
    const est = estimateFlexDiscount(1.6e-5, { prompt: 14, completion: 146 }, deepseekCost);
    expect(est).toBeDefined();
    // List price: (14×0.14 + 146×0.28) / 1e6 = 4.284e-5.
    expect(est!.listUsd).toBeCloseTo(4.284e-5, 10);
    expect(est!.pct).toBe(63);
  });

  it("glm pair: charged 3.9e-5 for 17/64 tokens → ~88% off list", async () => {
    const est = estimateFlexDiscount(3.9e-5, { prompt: 17, completion: 64 }, glmCost);
    // List price: (17×1.45 + 64×4.5) / 1e6 = 3.1265e-4.
    expect(est!.listUsd).toBeCloseTo(3.1265e-4, 10);
    expect(est!.pct).toBe(88);
  });

  it("cached input tokens are billed at the cacheRead rate", async () => {
    const est = estimateFlexDiscount(3e-6, { prompt: 100, cachedInput: 60, completion: 0 }, deepseekCost);
    // List price: (40×0.14 + 60×0.028) / 1e6 = 7.28e-6.
    expect(est!.listUsd).toBeCloseTo(7.28e-6, 11);
    expect(est!.pct).toBe(59);
  });

  it("returns undefined without usage tokens or with zero list price", async () => {
    expect(estimateFlexDiscount(1e-5, {}, deepseekCost)).toBeUndefined();
    expect(
      estimateFlexDiscount(1e-5, { prompt: 10, completion: 10 }, { input: 0, output: 0, cacheRead: 0 }),
    ).toBeUndefined();
  });

  it("clamps to 0 when charged at or above list price", async () => {
    const est = estimateFlexDiscount(1e-4, { prompt: 14, completion: 146 }, deepseekCost);
    expect(est!.pct).toBe(0);
  });
});
