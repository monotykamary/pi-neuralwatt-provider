import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home: string;
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

async function load() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nw-refresh-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
  fs.mkdirSync(path.join(home, "extensions"));
  fs.mkdirSync(path.join(home, "cache"));
  fs.writeFileSync(path.join(home, "extensions", "neuralwatt.json"), JSON.stringify({
    energy: "off", quota: "off", carbon: "off", mcr: "off", baseUrl: "https://proxy.example/v1",
    hostedTools: false, modelOverrides: { "kimi-k3": { samplingParams: { top_k: 24, seed: 42 } } },
  }));
  fs.writeFileSync(path.join(home, "cache", "neuralwatt-models.json"), JSON.stringify([
    { id: "clef-flash", name: "Old mistaken chat entry", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 131072 },
    { id: "kimi-k3", name: "Kimi", reasoning: true, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 131072, vision: { maxImagesPerRequest: 20 } },
  ]));
  vi.resetModules();
  return import("../index");
}

describe("stale and authenticated model refresh", () => {
  it("upgrades old cached operation/image metadata and loads sampling config", async () => {
    const { getStaleModels } = await load();
    const models = getStaleModels();
    expect(models.find(m => m.id === "clef-flash")).toMatchObject({ type: "classifier", api: "typesafe-system-one", contextWindow: 262128 });
    expect(models.find(m => m.id === "kimi-k3")).toMatchObject({ vision: { maxImagesPerTurn: 20, maxImagesPerRequest: 200 }, samplingParams: { top_k: 24, seed: 42 } });
  });

  it("hot-registers classifiers and fresh vision/hosted capabilities through the configured proxy", async () => {
    const extension = await load();
    const handlers = new Map<string, Function>();
    const registrations: any[] = [];
    let refreshed!: () => void;
    const done = new Promise<void>(resolve => { refreshed = resolve; });
    const fetch = vi.fn(async (url, init) => {
      expect(url).toBe("https://proxy.example/v1/models");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer private-test-key");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ data: [
        { id: "new-clef", metadata: { capabilities: { task: "decision" }, limits: { max_context_length: 64000, max_output_tokens: 0 } } },
        { id: "kimi-k3", metadata: { capabilities: { vision: true, hosted_tools: true, reasoning: true }, limits: { max_context_length: 1048576, max_images: 30, max_images_total: 300 } } },
      ] });
    });
    vi.stubGlobal("fetch", fetch);
    extension.default({ on: (name, fn) => handlers.set(name, fn), registerCommand: () => {},
      registerProvider: (_name, config) => { registrations.push(config); if (config.models.some(m => m.id === "new-clef")) refreshed(); },
    } as any);
    await handlers.get("session_start")!({}, {
      model: { provider: "other" }, sessionManager: { getBranch: () => [] },
      modelRegistry: { getApiKeyForProvider: async () => "private-test-key" },
      ui: { setStatus: () => {}, setWidget: () => {} },
    });
    await done;
    const config = registrations.at(-1);
    expect(config.classifiers["typesafe-system-one"].classify).toBeTypeOf("function");
    expect(config.models.find(m => m.id === "new-clef")).toMatchObject({ type: "classifier", api: "typesafe-system-one" });
    expect(config.models.find(m => m.id === "kimi-k3")).toMatchObject({ hostedTools: true, vision: { maxImagesPerTurn: 30, maxImagesPerRequest: 300 }, samplingParams: { seed: 42 } });
    expect(fetch).toHaveBeenCalledOnce();
    await handlers.get("session_shutdown")!({}, { ui: { setStatus: () => {}, setWidget: () => {} } });
  });
});
