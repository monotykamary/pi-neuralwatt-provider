import { describe, expect, it } from "vitest";
import { wrapStreamPassthrough, BILLING_LIST_MISMATCH_THRESHOLD_USD } from "../index";
import { createAssistantMessageEventStream, type AssistantMessageEvent } from "@earendil-works/pi-ai";

function doneEvent(costTotal: number) {
  return {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "neuralwatt",
      model: "glm-5.2",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0.0000145, output: 0.0000225, cacheRead: 0, cacheWrite: 0, total: costTotal },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  } as unknown as AssistantMessageEvent;
}

function drain(stream: AsyncIterable<AssistantMessageEvent>) {
  const seen: AssistantMessageEvent[] = [];
  return (async () => {
    for await (const e of stream) seen.push(e);
    return seen;
  })();
}

describe("wrapStreamPassthrough", () => {
  it("passes the done event through unchanged — usage.cost keeps its list price", async () => {
    // Regression guard for the reverted design: the billed-cost rewrite is
    // gone; whatever pi-ai list-priced must reach pi untouched.
    const done = doneEvent(0.000037);
    const inner = createAssistantMessageEventStream();
    inner.push(done);
    inner.end();
    const wrapped = wrapStreamPassthrough(inner);
    const events = await drain(wrapped);
    expect(events).toHaveLength(1);
    const msg = (events[0] as any).message;
    expect(msg.usage.cost.total).toBe(0.000037);
    expect(msg).toBe((done as any).message); // identity: message object untouched
    const resultMessage = await wrapped.result();
    expect((resultMessage as any).usage.cost.total).toBe(0.000037);
  });

  it("preserves event order for multi-event streams", async () => {
    const inner = createAssistantMessageEventStream();
    const partial = { type: "text_delta", delta: "hi" } as unknown as AssistantMessageEvent;
    inner.push(partial);
    inner.push(doneEvent(0.0001));
    inner.end();
    const events = await drain(wrapStreamPassthrough(inner));
    expect(events.map((e) => e.type)).toEqual(["text_delta", "done"]);
  });

  it("invokes onSettled exactly once when the stream ends", async () => {
    const inner = createAssistantMessageEventStream();
    inner.push(doneEvent(0.0001));
    inner.end();
    let settled = 0;
    await drain(wrapStreamPassthrough(inner, () => settled++));
    await new Promise((r) => setTimeout(r, 0)); // let the pump run its tail
    expect(settled).toBe(1);
  });

  it("passes error events through unmodified and still settles", async () => {
    const inner = createAssistantMessageEventStream();
    inner.push({ type: "error", reason: "unknown", error: new Error("boom") } as unknown as AssistantMessageEvent);
    inner.end();
    let settled = false;
    const events = await drain(wrapStreamPassthrough(inner, () => {
      settled = true;
    }));
    expect(events[0].type).toBe("error");
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(true);
  });

  it("documents the 1¢ billed-vs-list mismatch threshold", () => {
    expect(BILLING_LIST_MISMATCH_THRESHOLD_USD).toBe(0.01);
  });
});
