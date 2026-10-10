import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import registerNeuralwatt, { consumePendingMCR, getPendingState, resetSessionState, streamNeuralwatt } from "../index";
import { __resetStreamCalls, __streamCalls } from "@earendil-works/pi-ai/compat";

// turn_end must only wait on the main agent loop's own response tee. Other
// extensions' background model calls (memory workers, classifiers) go through
// the same provider; pi awaits turn_end before the next main-loop request, so
// waiting on their streams stalls the main loop.

const model = {
  id: "glm-5.2",
  provider: "neuralwatt",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32768,
};
const context = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
const enc = new TextEncoder();
const CHAT_URL = "https://api.neuralwatt.com/v1/chat/completions";

type Handler = (event: any, ctx: any) => Promise<void> | void;

const handlers = new Map<string, Handler[]>();
const entries: Array<{ type: string; data: any }> = [];
const pi = {
  on(event: string, handler: Handler) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  },
  registerProvider() {},
  registerCommand() {},
  appendEntry(type: string, data: any) {
    entries.push({ type, data });
  },
  events: { emit() {} },
};

function makeCtx(sessionId = "sess-main") {
  return {
    model: { id: "other-model", provider: "other" },
    sessionManager: { getSessionId: () => sessionId },
    ui: { setStatus() {}, setWidget() {}, setFooter() {}, notify() {} },
  };
}

function turnEnd(ctx = makeCtx(), turnIndex = 0): Promise<void> {
  return handlers.get("turn_end")![0]({ turnIndex }, ctx) as Promise<void>;
}

function openBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    body,
    send: (line: string) => controller.enqueue(enc.encode(line)),
    close: () => { try { controller.close(); } catch { /* already closed */ } },
  };
}

// Start a Neuralwatt stream and open its response through the per-request
// energy fetch wrapper (as pi-ai would), returning the wrapped response.
async function startStream(body: ReadableStream<Uint8Array>, extraOptions: Record<string, unknown> = {}) {
  const upstream = vi.fn().mockResolvedValueOnce(new Response(body));
  const stream = streamNeuralwatt(model, context, { apiKey: "sk-test", fetch: upstream, ...extraOptions } as any);
  const wrappedFetch = __streamCalls[__streamCalls.length - 1].options.fetch as typeof globalThis.fetch;
  const response = await wrappedFetch(CHAT_URL);
  return { stream, response };
}

const sleep = (ms: number) => new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms));

describe("turn_end waits only on the main loop's own tee", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    registerNeuralwatt(pi as any);
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // turn_end may fetch quota; keep it off the network.
    globalThis.fetch = vi.fn(async () => new Response("", { status: 500 })) as any;
    resetSessionState();
    __resetStreamCalls();
    entries.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves promptly while an unrelated background tee is still open", async () => {
    const bg = openBody();
    // No sessionId: an extension/background call (e.g. a memory worker).
    const { stream } = await startStream(bg.body);
    bg.send(': energy {"energy_joules":50}\n');
    try {
      const outcome = await Promise.race([turnEnd().then(() => "done" as const), sleep(200)]);
      expect(outcome).toBe("done");
      expect(getPendingState().backgroundTeeReader).toBeDefined(); // still open
      expect(entries).toHaveLength(0);
    } finally {
      bg.close();
      stream.end();
    }
    await getPendingState().backgroundTeeReader;
  });

  it("still awaits and commits the main loop's own tee", async () => {
    const main = openBody();
    const { stream } = await startStream(main.body, { sessionId: "sess-main" });
    // Energy arrives after turn_end has started: it must still be committed.
    setTimeout(() => {
      main.send(': energy {"energy_joules":7}\n');
      main.send(': cost {"request_cost_usd":0.002}\n');
      main.close();
    }, 30);
    await turnEnd(makeCtx("sess-main"), 1);
    stream.end();

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("neuralwatt-energy");
    expect(entries[0].data.energy_joules).toBe(7);
    expect(entries[0].data.cost_usd).toBe(0.002);
  });

  it("keeps background energy and MCR data out of the main session's turn", async () => {
    // First turn records the active session id.
    await turnEnd(makeCtx("sess-main"));

    const bg = openBody();
    const main = openBody();
    // A foreign session id (e.g. an in-process child session) is background too.
    const { stream: bgStream } = await startStream(bg.body, { sessionId: "sess-other" });
    const { stream: mainStream } = await startStream(main.body, { sessionId: "sess-main" });

    bg.send(': energy {"energy_joules":50}\n');
    bg.send(': cost {"request_cost_usd":0.05}\n');
    bg.send(': mcr-session {"session_fp":"bg-fp","safe_drop_before":9}\n');
    bg.close();
    await getPendingState().backgroundTeeReader;

    main.send(': energy {"energy_joules":7}\n');
    main.send(': mcr-session {"session_fp":"main-fp","safe_drop_before":2}\n');
    main.close();

    await turnEnd(makeCtx("sess-main"), 1);
    bgStream.end();
    mainStream.end();

    expect(entries).toHaveLength(1);
    expect(entries[0].data.energy_joules).toBe(7);
    expect(entries[0].data.cost_usd).toBe(0);
    expect(entries[0].data.sse_mcr_session_raw.session_fp).toBe("main-fp");
    expect(consumePendingMCR().mcrSessionRaw?.session_fp).toBe("main-fp");

    const state = getPendingState();
    expect(state.backgroundEnergyJoules).toBe(50);
    expect(state.backgroundCostUsd).toBe(0.05);
    expect(state.pendingEnergyJoules).toBe(0);
  });
});
