import { describe, expect, it, beforeEach } from "vitest";
import {
  readEnergyFromTee,
  resetSessionState,
  getPendingState,
  FLEX_DISCOUNT_PCT,
  FLEX_PRICING_MULTIPLIER,
  flexConsumedCostUsdEst,
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

describe("fixed flex discount (per flex-tier docs)", () => {
  // The docs state a fixed 35% off standard (0.65 multiplier). Charged cost
  // is energy-derived, so token list-price math must not be used to derive
  // — or sanity-check — the discount (that was the old estimateFlexDiscount
  // bug: it produced 2–98% swings that scaled with queue time).
  it("is 35% off with a 0.65 pricing multiplier", () => {
    expect(FLEX_PRICING_MULTIPLIER).toBe(0.65);
    expect(FLEX_DISCOUNT_PCT).toBe(35);
  });

  it("derives the consumed (standard-price) cost by dividing by the multiplier", () => {
    expect(flexConsumedCostUsdEst(6.5e-6)).toBeCloseTo(1e-5, 12);
    expect(flexConsumedCostUsdEst(0)).toBeUndefined();
    expect(flexConsumedCostUsdEst(-1)).toBeUndefined();
  });
});
