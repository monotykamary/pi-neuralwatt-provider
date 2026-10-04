import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHostedTools, applyHostedTools } from "../hosted-tools";
import { __setConfigForTest, buildModels, streamNeuralwatt } from "../index";
import { __resetStreamCalls, __streamCalls } from "@earendil-works/pi-ai/compat";

const base = { energy: "off", quota: "off", mcr: "off", carbon: "off", glyphs: "auto", hideOnOtherProvider: true } as const;
afterEach(() => __setConfigForTest(undefined));

describe("hosted tool request policy", () => {
  it("is opt-in and validates names, deduplicates, and fails closed on malformed budgets", () => {
    expect(parseHostedTools(undefined)).toBeUndefined();
    expect(parseHostedTools(false)).toBe(false);
    expect(parseHostedTools({ tools: ["nw_web_search", "nw_web_search"] })).toEqual({ tools: ["nw_web_search"] });
    for (const value of [true, null, [], { tools: ["nw_spawn_subagents"] }, { tools: ["nw_consult"], buget: {} },
      ...[-1, NaN, Infinity, "1", null].map(max_cost_usd => ({ tools: ["nw_consult"], budget: { max_cost_usd } })),
      { tools: ["nw_consult"], budget: { max_cost: 1 } }]) expect(parseHostedTools(value)).toBe(false);
    expect(parseHostedTools({ tools: [], budget: { max_cost_usd: 0 } })).toEqual({ tools: [], budget: { max_cost_usd: 0 } });
  });

  it("uses each API's tool shape, preserves local tools, and deduplicates caller entries", () => {
    for (const responses of [false, true]) {
      const local = responses ? { type: "function", name: "read" } : { type: "function", function: { name: "read" } };
      const config = parseHostedTools({ tools: ["nw_web_search", "nw_check_budget"] });
      const input = { tools: [local], metadata: { user: "test" } };
      const output = applyHostedTools(input, responses, config, true);
      expect(output.tools).toHaveLength(3);
      expect(output.tools[0]).toBe(local);
      expect(output.tools[1]).toEqual(responses ? { type: "function", name: "nw_web_search" } : { type: "function", function: { name: "nw_web_search" } });
      expect(input.tools).toHaveLength(1);
      expect(applyHostedTools(output, responses, config, true).tools).toHaveLength(3);
      expect(() => applyHostedTools(input, responses, config, false)).toThrow("does not advertise");
    }
  });

  it("tightens rather than loosens budget ceilings and preserves unrelated metadata", () => {
    const output = applyHostedTools({ metadata: { marker: "test", hosted_tools_budget: { max_cost_usd: 0.01, max_energy_wh: 100 } } }, false,
      { tools: [], budget: { max_cost_usd: 0.1, max_energy_wh: 2 } });
    expect(output.metadata).toEqual({ marker: "test", hosted_tools_budget: { max_cost_usd: 0.01, max_energy_wh: 2 } });
    const original = { tools: [] };
    expect(applyHostedTools(original, false, undefined)).toBe(original);
  });

  it("chains caller replacement, preserve-thinking and hosted settings on both surfaces", async () => {
    for (const api of ["chat-completions", "responses"] as const) {
      __resetStreamCalls();
      __setConfigForTest({ ...base, api, hostedTools: { tools: ["nw_check_budget"], budget: { max_cost_usd: 0 } } });
      streamNeuralwatt({ id: "test", hostedTools: true, compat: { chatTemplateKwargs: { preserve_thinking: true } } }, { messages: [] }, {
        apiKey: "test", onPayload: () => ({ marker: "replacement", metadata: { retained: true } }),
      }).end();
      const { options, model } = __streamCalls[0];
      const output = await options.onPayload({}, model);
      expect(output).toMatchObject({ marker: "replacement", chat_template_kwargs: { preserve_thinking: true }, metadata: { retained: true, hosted_tools_budget: { max_cost_usd: 0 } } });
      expect(output.tools).toHaveLength(1);
      if (api === "responses") expect(output.store).toBe(true);
    }
  });

  it("sets an opt-out header without changing auth/caller headers or global fetch", async () => {
    __resetStreamCalls();
    __setConfigForTest({ ...base, hostedTools: false });
    const original = globalThis.fetch;
    const fetch = vi.fn(async (_url, init) => {
      const headers = new Headers(init.headers);
      expect(headers.get("x-nw-tools-opt-out")).toBe("true");
      expect(headers.get("authorization")).toBe("Bearer test");
      expect(headers.get("x-custom")).toBe("kept");
      return new Response(null, { status: 204 });
    });
    streamNeuralwatt({ id: "test" }, { messages: [] }, { apiKey: "test", fetch }).end();
    await __streamCalls[0].options.fetch("https://api.neuralwatt.com/v1/chat/completions", { headers: { authorization: "Bearer test", "x-custom": "kept" } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toBe(original);
  });

  it("preserves and deep-merges per-model sampling defaults through the build pipeline", () => {
    const model = { id: "m", name: "M", reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100, maxTokens: 10,
      samplingParams: { top_k: 20, seed: 1 } };
    expect(buildModels([model], [], { m: { samplingParams: { repetition_penalty: 1.1 } } }, { m: { samplingParams: { seed: 42 } } }, {})[0].samplingParams)
      .toEqual({ top_k: 20, repetition_penalty: 1.1, seed: 42 });
  });
});
