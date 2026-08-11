import { describe, it, expect } from "vitest";
import {
  applyBilledCostToUsage,
  wrapStreamWithBilledCost,
  readEnergyFromTee,
  resetSessionState,
} from "../index";
import { createAssistantMessageEventStream, type AssistantMessageEvent } from "@earendil-works/pi-ai";

describe("applyBilledCostToUsage", () => {
  it("scales components proportionally and sets total to the billed amount", () => {
    const usage = {
      input: 100, output: 50, cacheRead: 20, cacheWrite: 0, totalTokens: 170,
      cost: { input: 0.002, output: 0.00005, cacheRead: 0.00004, cacheWrite: 0, total: 0.00209 },
    };
    applyBilledCostToUsage(usage, 0.000031);
    expect(usage.cost.total).toBe(0.000031);
    expect(usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite)
      .toBeCloseTo(0.000031, 12);
    expect(usage.cost.input).toBeCloseTo(0.000031 * (0.002 / 0.00209), 12);
    expect(usage.input).toBe(100); // token counts never touched
  });

  it("handles a zero/empty list total by zeroing components", () => {
    const usage = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    applyBilledCostToUsage(usage, 0.0005);
    expect(usage.cost.total).toBe(0.0005);
    expect(usage.cost.input).toBe(0);
  });

  it("is a no-op when usage or cost is missing", () => {
    expect(() => applyBilledCostToUsage(undefined as any, 1)).not.toThrow();
    expect(() => applyBilledCostToUsage({} as any, 1)).not.toThrow();
  });
});

function pushDone(usageCost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }) {
  const inner = createAssistantMessageEventStream();
  inner.push({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "neuralwatt",
      model: "glm-5.2-flex",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: usageCost },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  } as unknown as AssistantMessageEvent);
  inner.end();
  return inner;
}

describe("wrapStreamWithBilledCost", () => {
  it("replaces usage.cost on the done event with the billed amount", async () => {
    const inner = pushDone({ input: 0.002, output: 0.00005, cacheRead: 0, cacheWrite: 0, total: 0.00205 });
    const wrapped = wrapStreamWithBilledCost(inner, async () => 0.000031);
    const events: AssistantMessageEvent[] = [];
    for await (const e of wrapped) events.push(e);
    expect(events).toHaveLength(1);
    const msg = (events[0] as any).message;
    expect(msg.usage.cost.total).toBe(0.000031);
    const resultMessage = await wrapped.result();
    expect((resultMessage as any).usage.cost.total).toBe(0.000031);
  });

  it("waits for getBilledUsd (tee settle) before pushing done", async () => {
    const inner = pushDone({ input: 0.002, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 });
    let release!: (v: number) => void;
    let observed: number | undefined;
    const billedPromise = new Promise<number>((r) => { release = r; });
    const wrapped = wrapStreamWithBilledCost(inner, async () => {
      const v = await billedPromise;
      return v;
    });
    const seen: AssistantMessageEvent[] = [];
    const pump = (async () => { for await (const e of wrapped) { seen.push(e); if (e.type === "done") observed = (e as any).message.usage.cost.total; } })();
    await new Promise((r) => setTimeout(r, 20));
    expect(observed).toBeUndefined(); // nothing pushed until billed resolves
    release(0.000031);
    await pump;
    expect(observed).toBe(0.000031);
  });

  it("passes done through unchanged when no billed cost is available", async () => {
    const inner = pushDone({ input: 0.002, output: 0.00005, cacheRead: 0, cacheWrite: 0, total: 0.00205 });
    const wrapped = wrapStreamWithBilledCost(inner, async () => undefined);
    const events: AssistantMessageEvent[] = [];
    for await (const e of wrapped) events.push(e);
    expect((events[0] as any).message.usage.cost.total).toBe(0.00205);
  });

  it("passes error events through unmodified", async () => {
    const inner = createAssistantMessageEventStream();
    inner.push({ type: "error", reason: "unknown", error: new Error("boom") } as unknown as AssistantMessageEvent);
    inner.end();
    const wrapped = wrapStreamWithBilledCost(inner, async () => 0.5);
    const events: AssistantMessageEvent[] = [];
    for await (const e of wrapped) events.push(e);
    expect(events[0].type).toBe("error");
  });
});

function sseStream(payload: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(payload));
      c.close();
    },
  });
}

describe("readEnergyFromTee billed-cost callback", () => {
  it("reports the SSE data chunk's cost_usd (flex, exact per-request)", async () => {
    resetSessionState();
    const payload = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      'data: {"service_tier":"flex","cost_usd":0.000031,"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      'data: [DONE]',
      ': cost {"request_cost_usd":0.000031}',
      '',
    ].join("\n");
    let got: number | undefined;
    await readEnergyFromTee(sseStream(payload), (c) => { got = c; });
    expect(got).toBe(0.000031);
  });

  it("falls back to the cost comment sum when no data chunk carries cost_usd", async () => {
    resetSessionState();
    const payload = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: [DONE]',
      ': cost {"request_cost_usd":0.0002}',
      ': cost {"request_cost_usd":0.0003}',
      '',
    ].join("\n");
    let got: number | undefined;
    await readEnergyFromTee(sseStream(payload), (c) => { got = c; });
    expect(got).toBeCloseTo(0.0005, 12);
  });

  it("reports undefined when neither source exists", async () => {
    resetSessionState();
    const payload = ['data: {"choices":[{"delta":{"content":"hi"}}]}', 'data: [DONE]', ''].join("\n");
    let got: number | undefined = -1;
    await readEnergyFromTee(sseStream(payload), (c) => { got = c; });
    expect(got).toBeUndefined();
  });
});
