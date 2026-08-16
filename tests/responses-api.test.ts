import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { __setConfigForTest, resetSessionState, streamNeuralwatt } from "../index";
import type { NeuralwattConfig } from "../index";
import { __streamCalls, __resetStreamCalls, __setClamp } from "@earendil-works/pi-ai/compat";

const baseConfig: NeuralwattConfig = {
  energy: "widget",
  quota: "widget",
  mcr: "widget",
  carbon: "widget",
  hideOnOtherProvider: false,
  api: "chat-completions",
};

const model = {
  id: "kimi-k3",
  provider: "neuralwatt",
  reasoning: true,
  input: ["text"],
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", max: "max" },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32768,
};

const context = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

describe("streamNeuralwatt Responses API surface", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    __resetStreamCalls();
    resetSessionState();
    __setClamp((_m, level) => level);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __setConfigForTest(undefined); // reload from disk
  });

  it("defaults to the chat-completions surface", () => {
    __setConfigForTest({ ...baseConfig });
    const s = streamNeuralwatt(model, context, { apiKey: "sk-test" } as any);
    s.end();
    expect(__streamCalls).toHaveLength(1);
    expect(__streamCalls[0].model.api).toBe("openai-completions");
  });

  it("uses the openai-responses surface when api=responses", () => {
    __setConfigForTest({ ...baseConfig, api: "responses" });
    const s = streamNeuralwatt(model, context, { apiKey: "sk-test" } as any);
    s.end();
    expect(__streamCalls).toHaveLength(1);
    expect(__streamCalls[0].model.api).toBe("openai-responses");
  });

  it("tee interceptor matches /responses as well as /chat/completions", async () => {
    __setConfigForTest({ ...baseConfig, api: "responses" });
    // Stub upstream fetch so the wrapper never touches the network. A body that
    // stays open until we abort lets us observe the tee without a live stream.
    const upstream = async () =>
      new Response(
        new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } }),
        { status: 200 },
      );
    const s = streamNeuralwatt(model, context, { apiKey: "sk-test", fetch: upstream } as any);
    s.end();
    const fetchWrapper = __streamCalls[0].options.fetch as typeof globalThis.fetch;

    const res = await fetchWrapper("https://api.neuralwatt.com/v1/responses", {});
    // A teed body is a fresh ReadableStream distinct from the upstream body.
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();
  });

  it("defaults to store:true (ZDR) and strips reasoning.encrypted_content", async () => {
    __setConfigForTest({ ...baseConfig, api: "responses" });
    const s = streamNeuralwatt(model, context, { apiKey: "sk-test", reasoning: "high" } as any);
    s.end();
    const onPayload = __streamCalls[0].options.onPayload as (p: any, m: any) => Promise<any>;
    expect(onPayload).toEqual(expect.any(Function));

    // Simulate pi-ai's Responses params for a reasoning model (pi-ai sends store:false).
    const out = await onPayload(
      {
        model: "kimi-k3",
        input: [],
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "high", summary: "auto" },
      },
      model,
    );
    expect(out.store).toBe(true); // overridden to true (default)
    expect(out.include).toBeUndefined();
    // Untouched fields survive.
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.model).toBe("kimi-k3");
  });

  it("storeResponses:false forces store:false and strips previous_response_id", async () => {
    __setConfigForTest({ ...baseConfig, api: "responses", storeResponses: false });
    const s = streamNeuralwatt(model, context, { apiKey: "sk-test" } as any);
    s.end();
    const onPayload = __streamCalls[0].options.onPayload as (p: any, m: any) => Promise<any>;
    const out = await onPayload(
      { model: "kimi-k3", store: true, previous_response_id: "resp_abc", include: ["reasoning.encrypted_content"] },
      model,
    );
    expect(out.store).toBe(false);
    expect("previous_response_id" in out).toBe(false);
    expect(out.include).toBeUndefined();
  });

  it("keeps a non-reasoning include list intact", async () => {
    __setConfigForTest({ ...baseConfig, api: "responses" });
    const s = streamNeuralwatt(model, context, { apiKey: "sk-test" } as any);
    s.end();
    const onPayload = __streamCalls[0].options.onPayload as (p: any, m: any) => Promise<any>;
    const out = await onPayload({ model: "kimi-k3", store: false, include: ["some_other_include"] }, model);
    expect(out.include).toEqual(["some_other_include"]);
    expect(out.store).toBe(true); // default retention
  });
});
