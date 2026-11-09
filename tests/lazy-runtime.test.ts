// Startup stays cheap: loading the extension registers the provider and its
// whole catalog without pulling in pi-ai's stream implementations or the
// built-in provider registry. Both load on first use, and the first request
// still streams through the deferred path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let home: string | undefined;
let loads: { compat: number; providers: number };

afterEach(() => {
  vi.doUnmock("@earendil-works/pi-ai/compat");
  vi.doUnmock("@earendil-works/pi-ai/providers/all");
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function assistant(text: string) {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "neuralwatt", model: "kimi-k2.6",
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
}

// Count module evaluations of the deferred entrypoints. The compat stand-in
// streams a real event sequence so the first request can be checked end to end.
async function loadExtension(options: { failCompat?: boolean } = {}) {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nw-lazy-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
  vi.stubEnv("NEURALWATT_API_KEY", "");
  loads = { compat: 0, providers: 0 };
  vi.resetModules();
  vi.doMock("@earendil-works/pi-ai/compat", async (importOriginal) => {
    loads.compat++;
    if (options.failCompat) throw new Error("compat unavailable");
    const original = await importOriginal<typeof import("./__mocks__/pi-ai")>();
    const streamOpenAICompletions = (model: any, context: any, streamOptions: any) => {
      original.__streamCalls.push({ model, context, options: streamOptions });
      const stream = original.createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = assistant("Hello");
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    };
    return { ...original, streamOpenAICompletions };
  });
  vi.doMock("@earendil-works/pi-ai/providers/all", async () => {
    loads.providers++;
    return {
      builtinProviders: () => [
        { id: "openai" },
        { id: "typesafe", classify: async (_model: any, _context: any, options: any) => ({ stopReason: "stop", answers: {}, apiKey: options?.apiKey }) },
      ],
    };
  });
  const index = await import("../index");
  const mcr = await import("../neuralwatt-mcr");
  return { index, mcr };
}

function stubPi() {
  const registrations: Array<{ name: string; config: any }> = [];
  const pi = {
    registerProvider: (name: string, config: any) => registrations.push({ name, config }),
    unregisterProvider: () => {},
    on: () => {},
    registerCommand: () => {},
    registerTool: () => {},
    registerFlag: () => {},
    registerShortcut: () => {},
    registerMessageRenderer: () => {},
    appendEntry: () => {},
    sendMessage: () => {},
    getFlag: () => undefined,
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    events: { on: () => () => {}, emit: () => {} },
  };
  return { pi: pi as any, registrations };
}

describe("lazy request runtime", () => {
  it("registers every model at load without loading stream implementations or the provider registry", async () => {
    const { index, mcr } = await loadExtension();
    const { pi, registrations } = stubPi();
    index.default(pi);
    mcr.default(pi);

    expect(loads).toEqual({ compat: 0, providers: 0 });
    const neuralwatt = registrations.filter(r => r.name === "neuralwatt");
    expect(neuralwatt.length).toBeGreaterThan(0);
    const config = neuralwatt[0].config;
    expect(config.models.length).toBe(index.getStaleModels().length);
    expect(config.models.length).toBeGreaterThan(0);
    expect(config.streamSimple).toBe(index.streamNeuralwatt);
    expect(config.classifiers["typesafe-system-one"].classify).toBeTypeOf("function");
  });

  it("streams the first request through the deferred runtime and reuses it afterwards", async () => {
    const { index } = await loadExtension();
    const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
    const model = { id: "kimi-k2.6", api: "neuralwatt", provider: "neuralwatt", input: ["text"] };

    const first = index.streamNeuralwatt(model, context, { apiKey: "sk-test" } as any);
    expect(loads.compat).toBe(0);
    const events: string[] = [];
    for await (const event of first) events.push(event.type);
    expect(events).toEqual(["start", "text_delta", "done"]);
    const result = await first.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content[0].text).toBe("Hello");
    expect(loads.compat).toBe(1);

    const { __streamCalls } = await import("@earendil-works/pi-ai/compat") as any;
    expect(__streamCalls).toHaveLength(1);
    expect(__streamCalls[0].model.api).toBe("openai-completions");
    expect(__streamCalls[0].options.apiKey).toBe("sk-test");
    expect(__streamCalls[0].options.fetch).toEqual(expect.any(Function));

    // Once loaded, the request is started synchronously, as before.
    const second = index.streamNeuralwatt(model, context, { apiKey: "sk-test" } as any);
    expect(__streamCalls).toHaveLength(2);
    expect((await second.result()).stopReason).toBe("stop");
    expect(loads.compat).toBe(1);
  });

  it("still rejects a request without an API key before loading anything", async () => {
    const { index } = await loadExtension();
    expect(() => index.streamNeuralwatt({ id: "kimi-k2.6" }, { messages: [] }, {} as any)).toThrow("No API key for Neuralwatt");
    expect(loads.compat).toBe(0);
  });

  it("ends the first request with an error event when the runtime cannot load", async () => {
    const { index } = await loadExtension({ failCompat: true });
    const stream = index.streamNeuralwatt({ id: "kimi-k2.6-flex", api: "neuralwatt", provider: "neuralwatt" }, { messages: [] }, { apiKey: "sk-test" } as any);
    expect(index.liveFlexQueueState().streams).toBe(1);
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", reason: "error", error: { stopReason: "error", provider: "neuralwatt", model: "kimi-k2.6-flex" } });
    // vitest wraps a throwing mock factory's error in its own message.
    expect(events[0].error.errorMessage).toMatch(/compat unavailable|error when mocking/);
    expect((await stream.result()).stopReason).toBe("error");
    expect(index.liveFlexQueueState().streams).toBe(0);
  });

  it("loads the System One classifier on first classify", async () => {
    const { index } = await loadExtension();
    const classify = index.makeProviderConfig().classifiers["typesafe-system-one"].classify;
    expect(loads.providers).toBe(0);
    const result = await classify({ id: "clef-flash" } as any, { state: {}, questions: {} } as any, { apiKey: "k1" } as any);
    expect(result).toMatchObject({ stopReason: "stop", apiKey: "k1" });
    await classify({ id: "clef-flash" } as any, { state: {}, questions: {} } as any, { apiKey: "k2" } as any);
    expect(loads.providers).toBe(1);
  });
});
