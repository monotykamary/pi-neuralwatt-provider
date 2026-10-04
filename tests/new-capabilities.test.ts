import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModels, makeProviderConfig, transformApiModel, streamNeuralwatt, __setConfigForTest } from "../index";
import { transformModel, cleanModelForJson } from "../scripts/update-models.js";
import { transformContextForImageLimits } from "../transform";
import { __resetStreamCalls, __streamCalls } from "@earendil-works/pi-ai/compat";

const apiModel = {
  id: "clef-flash",
  metadata: {
    display_name: "Clef Flash",
    capabilities: { task: "decision", vision: true, reasoning: false, streaming: false, developer_role: false },
    limits: { max_context_length: 262128, max_output_tokens: 0 },
    pricing: { input_per_million: 0.18, output_per_million: 0, cached_input_per_million: 0.018 },
  },
};
const context = { state: { message: "Thanks, it works!" }, questions: {
  sentiment: { type: "choice" as const, instructions: "Sentiment?", criteria: { positive: "Happy", negative: "Unhappy" } },
  approved: { type: "bool" as const, instructions: "Approved?", criteria: { true: "Yes", false: "No" } },
  urgency: { type: "score" as const, instructions: "Urgency?", criteria: ["None", "Immediate"] },
} };
const wire = { answers: {
  sentiment: { type: "choice", choice: "positive", probabilities: { positive: 0.9, negative: 0.1 }, confidence: 0.9 },
  approved: { type: "noul", noul: 0.8 },
  urgency: { type: "score", score: 0.1, confidence: 0.9 },
}, usage: { input_tokens: 300, output_tokens: 0 } };

function classifier() {
  const catalog = buildModels([transformApiModel(apiModel)!], [], {}, {}, {});
  const config = makeProviderConfig(catalog);
  return { config, model: { ...config.models[0], provider: "neuralwatt", baseUrl: "https://proxy.example/v1/" } as any };
}

afterEach(() => { vi.restoreAllMocks(); __setConfigForTest(undefined); });

describe("decision model catalog and native System One transport", () => {
  it("uses metadata.task (not an ID heuristic) in both generation paths", () => {
    for (const id of ["clef-flash", "future-decision-model"]) {
      const raw = { ...apiModel, id };
      const runtime = transformApiModel(raw)!;
      expect(runtime).toEqual(transformModel(raw));
      expect(cleanModelForJson(runtime)).toEqual(runtime);
      expect(runtime).toMatchObject({ type: "classifier", api: "typesafe-system-one", contextWindow: 262128, input: ["text", "image"] });
      expect(runtime).not.toHaveProperty("maxTokens");
      expect(runtime).not.toHaveProperty("reasoning");
      expect(runtime).not.toHaveProperty("compat");
    }
  });

  it("keeps classifier identity through patches, overrides and re-registration", () => {
    const catalog = buildModels([transformApiModel(apiModel)!], [], { "clef-flash": { cost: { input: 0.2 } } }, {
      "clef-flash": { compat: { supportsStore: true }, thinkingLevelMap: { high: "high" } },
    }, {});
    expect(catalog[0]).toMatchObject({ type: "classifier", cost: { input: 0.2 } });
    expect(catalog[0]).not.toHaveProperty("compat");
    expect(catalog[0]).not.toHaveProperty("thinkingLevelMap");
    expect(makeProviderConfig(catalog).classifiers["typesafe-system-one"].classify).toBeTypeOf("function");
  });

  it("routes choice, score and bool to /systemone with auth, hooks and usage", async () => {
    const { config, model } = classifier();
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://proxy.example/v1/systemone");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer offline-test");
      expect(JSON.parse(init.body)).toMatchObject({ model: "clef-flash", state: context.state, questions: {
        approved: { type: "noul" }, sentiment: { type: "choice" }, urgency: { type: "score" },
      }, marker: "hook" });
      return Response.json(wire);
    });
    const onResponse = vi.fn();
    const result = await config.classifiers["typesafe-system-one"].classify(model, context, {
      apiKey: "offline-test", fetch, maxRetries: 0,
      onPayload: p => ({ ...(p as object), marker: "hook" }), onResponse,
    });
    expect(result.stopReason).toBe("stop");
    expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
    expect(result.answers.sentiment).toMatchObject({ type: "choice", choice: "positive" });
    expect(result.answers.urgency).toMatchObject({ type: "score", score: 0.1 });
    expect(result.usage).toMatchObject({ input: 300, output: 0, totalTokens: 300 });
    expect(result.usage!.cost.total).toBeCloseTo(0.000054);
    expect(fetch).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledOnce();
  });

  it("reports missing auth, denied access, malformed results and cancellation without chat fallback", async () => {
    const { config, model } = classifier();
    const classify = config.classifiers["typesafe-system-one"].classify;
    const missing = await classify(model, context);
    expect(missing.stopReason).toBe("error");
    const denied = await classify(model, context, { apiKey: "test", maxRetries: 0,
      fetch: async () => Response.json({ detail: "Preview access required" }, { status: 403 }) });
    expect(denied.stopReason).toBe("error");
    expect(denied.errorMessage).toContain("Preview access required");
    const malformed = await classify(model, context, { apiKey: "test", maxRetries: 0,
      fetch: async () => Response.json({ answers: {}, usage: wire.usage }) });
    expect(malformed.stopReason).toBe("error");
    expect(malformed.usage?.input).toBe(300);
    const controller = new AbortController();
    const aborted = await classify(model, context, { apiKey: "test", signal: controller.signal, maxRetries: 0,
      fetch: async (_url, init) => { controller.abort(); init!.signal!.throwIfAborted(); throw new Error("unreachable"); } });
    expect(aborted.stopReason).toBe("aborted");
  });
});

const img = (id: number) => ({ type: "image", data: String(id), mimeType: "image/png" });
const images = (n: number) => Array.from({ length: n }, (_, i) => img(i));
const count = (c: any) => c.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === "image").length;

describe("per-turn versus conversation image limits", () => {
  it("derives 20/200 from both catalog paths and retains legacy whole-request overrides", () => {
    const raw = { id: "vision", metadata: { capabilities: { vision: true }, limits: { max_images: 20, max_images_total: 200 } } };
    expect(transformApiModel(raw)?.vision).toEqual({ maxImagesPerTurn: 20, maxImagesPerRequest: 200 });
    expect(transformModel(raw).vision).toEqual(transformApiModel(raw)?.vision);
    expect(buildModels([transformApiModel(raw)!], [], {}, { vision: { vision: { maxImagesPerRequest: 10 } } }, {})[0].vision)
      .toEqual({ maxImagesPerTurn: 20, maxImagesPerRequest: 10 });
  });

  it("keeps historical images past the per-turn cap and limits new tool-result images exactly", () => {
    const c = { messages: [
      { role: "user", content: images(20) }, { role: "assistant", content: "seen" },
      { role: "user", content: [img(21)] }, { role: "toolResult", content: images(21) },
    ] };
    const result = transformContextForImageLimits(c, { maxImagesPerTurn: 20, maxImagesPerRequest: 200 });
    expect(count(result)).toBe(40);
    expect(result.messages[0]).toBe(c.messages[0]);
    expect(count(c)).toBe(42);
  });

  it("applies the total cap with hysteresis and leaves an under-limit context identical", () => {
    const c = { messages: [{ role: "user", content: images(20) }, { role: "assistant", content: "seen" }, { role: "user", content: images(2) }] };
    expect(transformContextForImageLimits(c, { maxImagesPerTurn: 20, maxImagesPerRequest: 200 })).toBe(c);
    expect(count(transformContextForImageLimits(c, { maxImagesPerTurn: 20, maxImagesPerRequest: 20 }))).toBe(17);
    expect(count(transformContextForImageLimits(c, { maxImagesPerTurn: 0 }))).toBe(20);
  });

  it("wires limits through streaming on both API surfaces", () => {
    for (const api of ["chat-completions", "responses"] as const) {
      __resetStreamCalls();
      __setConfigForTest({ energy: "off", quota: "off", mcr: "off", carbon: "off", glyphs: "auto", hideOnOtherProvider: true, api });
      const c = { messages: [{ role: "user", content: images(20) }, { role: "assistant", content: "seen" }, { role: "user", content: images(2) }] };
      streamNeuralwatt({ id: "vision", vision: { maxImagesPerTurn: 20, maxImagesPerRequest: 200 } }, c, { apiKey: "test" }).end();
      expect(__streamCalls[0].context).toBe(c);
    }
  });
});
