import { describe, expect, it, beforeEach } from "vitest";
import { readEnergyFromTee, resetSessionState, getPendingState } from "../index";
import modelsData from "../models.json" with { type: "json" };
import customModelsData from "../custom-models.json" with { type: "json" };

type NeuralwattModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    thinkingFormat?: string;
    maxTokensField?: string;
    supportsStore?: boolean;
  };
  vision?: { maxImagesPerRequest?: number };
};

const flexModels = (customModelsData as NeuralwattModel[]).filter((m) =>
  m.id.includes("-flex"),
);
const allModels = [
  ...(modelsData as NeuralwattModel[]),
  ...(customModelsData as NeuralwattModel[]),
];

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

describe("flex model definitions", () => {
  it("has exactly two flex models", () => {
    expect(flexModels).toHaveLength(2);
  });

  it("includes GLM-5.1 Flex", () => {
    const glm = flexModels.find((m) => m.id === "glm-5.1-flex");
    expect(glm).toBeDefined();
    expect(glm!.name).toBe("GLM-5.1 Flex");
  });

  it("includes Kimi K2.6 Flex", () => {
    const kimi = flexModels.find((m) => m.id === "kimi-k2.6-flex");
    expect(kimi).toBeDefined();
    expect(kimi!.name).toBe("Kimi K2.6 Flex");
  });

  it("all flex models have reasoning enabled", () => {
    for (const model of flexModels) {
      expect(model.reasoning, `${model.id} should have reasoning: true`).toBe(true);
    }
  });

  it("flex models have supportsDeveloperRole: false", () => {
    for (const model of flexModels) {
      expect(
        model.compat?.supportsDeveloperRole,
        `${model.id} should have supportsDeveloperRole: false`,
      ).toBe(false);
    }
  });
});

describe("flex model cost parity with non-flex counterparts", () => {
  it("GLM-5.1 Flex has the same cost as GLM-5.1", () => {
    const flex = allModels.find((m) => m.id === "glm-5.1-flex")!;
    const base = allModels.find((m) => m.id === "zai-org/GLM-5.1-FP8")!;
    expect(flex.cost).toEqual(base.cost);
  });

  it("Kimi K2.6 Flex has the same cost as Kimi K2.6", () => {
    const flex = allModels.find((m) => m.id === "kimi-k2.6-flex")!;
    const base = allModels.find((m) => m.id === "moonshotai/Kimi-K2.6")!;
    expect(flex.cost).toEqual(base.cost);
  });

  it("GLM-5.1 Flex has the same contextWindow as GLM-5.1", () => {
    const flex = allModels.find((m) => m.id === "glm-5.1-flex")!;
    const base = allModels.find((m) => m.id === "zai-org/GLM-5.1-FP8")!;
    expect(flex.contextWindow).toBe(base.contextWindow);
  });

  it("Kimi K2.6 Flex has the same contextWindow as Kimi K2.6", () => {
    const flex = allModels.find((m) => m.id === "kimi-k2.6-flex")!;
    const base = allModels.find((m) => m.id === "moonshotai/Kimi-K2.6")!;
    expect(flex.contextWindow).toBe(base.contextWindow);
  });
});

describe("flex model input types", () => {
  it("GLM-5.1 Flex is text-only (no vision)", () => {
    const glm = flexModels.find((m) => m.id === "glm-5.1-flex")!;
    expect(glm.input).toEqual(["text"]);
    expect(glm.vision).toBeUndefined();
  });

  it("Kimi K2.6 Flex has vision support", () => {
    const kimi = flexModels.find((m) => m.id === "kimi-k2.6-flex")!;
    expect(kimi.input).toContain("image");
    expect(kimi.vision?.maxImagesPerRequest).toBe(20);
  });
});

describe("flex model streaming with delta.reasoning", () => {
  beforeEach(() => {
    resetSessionState();
  });

  it("parses energy from a stream that includes delta.reasoning chunks", async () => {
    // Simulates a realistic flex model SSE stream where reasoning comes
    // via delta.reasoning (the format Neuralwatt uses for GLM/Kimi models)
    const chunks = [
      str('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n'),
      str('data: {"choices":[{"delta":{"reasoning":"The user asks what is 2+2."}}]}\n\n'),
      str('data: {"choices":[{"delta":{"reasoning":" This is simple addition."}}]}\n\n'),
      str('data: {"choices":[{"delta":{"content":"4"}}]}\n\n'),
      str(": energy {\"energy_joules\":55.5,\"duration_seconds\":1.2}\n"),
      str(": cost {\"request_cost_usd\":0.000077}\n"),
      str("data: [DONE]\n\n"),
    ];

    const body = makeStream(chunks);
    await readEnergyFromTee(body);

    const state = getPendingState();
    expect(state.pendingEnergyJoules).toBe(55.5);
    expect(state.pendingCostUsd).toBe(0.000077);
    expect((state.pendingEnergyRaw as any).duration_seconds).toBe(1.2);
  });

  it("handles energy comment arriving after a long reasoning stream", async () => {
    // Flex models may take much longer to process; the energy comment
    // typically arrives after all content has been streamed.
    const reasoningChunks = Array.from({ length: 50 }, (_, i) =>
      str(`data: {"choices":[{"delta":{"reasoning":"thinking step ${i + 1}..."}}]}\n\n`),
    );
    const contentChunks = [
      str('data: {"choices":[{"delta":{"content":"The answer is "}}]}\n\n'),
      str('data: {"choices":[{"delta":{"content":"127.05"}}]}\n\n'),
    ];
    const trailing = [
      str(": energy {\"energy_joules\":643.15,\"energy_kwh\":0.000178654,\"avg_power_watts\":4491.7,\"duration_seconds\":19.932}\n"),
      str(": cost {\"request_cost_usd\":0.000893}\n"),
    ];

    const body = makeStream([...reasoningChunks, ...contentChunks, ...trailing]);
    await readEnergyFromTee(body);

    const state = getPendingState();
    expect(state.pendingEnergyJoules).toBe(643.15);
    expect(state.pendingCostUsd).toBe(0.000893);
    expect((state.pendingEnergyRaw as any).energy_kwh).toBe(0.000178654);
    expect((state.pendingEnergyRaw as any).avg_power_watts).toBe(4491.7);
    expect((state.pendingEnergyRaw as any).duration_seconds).toBe(19.932);
  });

  it("captures uncapped energy fields present in flex model responses", async () => {
    // Kimi K2.6 flex returns uncapped attribution fields since ratio_was_capped is true
    const chunks = [
      str('data: {"choices":[{"delta":{"content":"4"}}]}\n\n'),
      str(
        ': energy {"energy_joules":48.91,"attribution_ratio":0.07,"ratio_was_capped":true,"uncapped_attribution_ratio":1.0,"uncapped_energy_joules":698.72,"uncapped_energy_kwh":0.000194089}\n',
      ),
      str(': cost {"request_cost_usd":0.000068}\n'),
    ];

    const body = makeStream(chunks);
    await readEnergyFromTee(body);

    const state = getPendingState();
    expect(state.pendingEnergyJoules).toBe(48.91);
    expect((state.pendingEnergyRaw as any).attribution_ratio).toBe(0.07);
    expect((state.pendingEnergyRaw as any).ratio_was_capped).toBe(true);
    expect((state.pendingEnergyRaw as any).uncapped_attribution_ratio).toBe(1.0);
    expect((state.pendingEnergyRaw as any).uncapped_energy_joules).toBe(698.72);
    expect((state.pendingEnergyRaw as any).uncapped_energy_kwh).toBe(0.000194089);
  });
});

describe("flex model non-stream response structure", () => {
  it("flex models are defined but don't need special transform", () => {
    // The non-stream API returns energy/cost at the top level, separate from
    // the SSE comment mechanism. Flex models use the same streaming path as
    // other models — the variable latency is server-side, not client-side.
    // No special transform is needed in the extension for flex routing.
    for (const model of flexModels) {
      expect(model.id).toMatch(/-flex$/);
      // Flex models are not special in terms of compat — they use the same
      // delta.reasoning and SSE comment format as their non-flex counterparts
      expect(model.compat?.thinkingFormat).toBeUndefined();
    }
  });
});

describe("flex canary model separation", () => {
  const canaryModels = (customModelsData as NeuralwattModel[]).filter((m) =>
    m.id.includes("-canary"),
  );

  it("flex and canary models are distinct", () => {
    const flexIds = new Set(flexModels.map((m) => m.id));
    const canaryIds = new Set(canaryModels.map((m) => m.id));
    const overlap = [...flexIds].filter((id) => canaryIds.has(id));
    expect(overlap).toHaveLength(0);
  });

  it("canary and flex models share costs with their base models", () => {
    const glmCanary = allModels.find((m) => m.id === "glm-5.1-canary")!;
    const glmFlex = allModels.find((m) => m.id === "glm-5.1-flex")!;
    const glmBase = allModels.find((m) => m.id === "zai-org/GLM-5.1-FP8")!;

    expect(glmCanary.cost).toEqual(glmBase.cost);
    expect(glmFlex.cost).toEqual(glmBase.cost);

    const kimiCanary = allModels.find((m) => m.id === "kimi-k2.6-canary")!;
    const kimiFlex = allModels.find((m) => m.id === "kimi-k2.6-flex")!;
    const kimiBase = allModels.find((m) => m.id === "moonshotai/Kimi-K2.6")!;

    expect(kimiCanary.cost).toEqual(kimiBase.cost);
    expect(kimiFlex.cost).toEqual(kimiBase.cost);
  });
});
