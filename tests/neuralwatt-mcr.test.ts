// Tests for the Neuralwatt MCR Pi extension wrapper.
//
// The wrapper delegates to Chad's upstream @neuralwatt/pi-mcr-extension with
// two runtime patches: (1) registerProvider intercepted to strip models/api
// and $-prefix env vars, (2) turn_end SSE bridge handler added.
//
// After the wrapper runs, it re-registers our full provider (with streamSimple)
// to guarantee it wins over any load-time registerProvider from Chad's npm
// package. So pi.providers["neuralwatt"] always has our full config.
//
// We run each test in an isolated $HOME so the extension's append-only log
// file is observable and does not leak across tests.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Handler = (event: any, ctx: any) => any;

interface MockPi {
  handlers: Map<string, Handler[]>;
  providers: Record<string, any>;
  registeredProviders: Array<{ name: string; config: any }>;
  on: (event: string, handler: Handler) => void;
  registerProvider: (name: string, config: any) => void;
  appendEntry: (_type: string, _data: any) => void;
}

function makeMockPi(): MockPi {
  const handlers = new Map<string, Handler[]>();
  const providers: Record<string, any> = {};
  const registeredProviders: Array<{ name: string; config: any }> = [];
  return {
    handlers,
    providers,
    registeredProviders,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerProvider(name, config) {
      providers[name] = config;
      registeredProviders.push({ name, config });
    },
    appendEntry() {},
  };
}

function makeCtx(modelId: string) {
  return {
    model: { id: modelId },
    sessionManager: { getSessionId: () => "sess-test-1234" },
    ui: { setStatus: () => {} },
  };
}

// Mirror of the SDK's resolveConfigValue for $-prefixed env-var references.
function resolveConfigValue(value: string): string {
  if (value.startsWith("$")) {
    const envName = value.slice(1);
    return process.env[envName] || envName;
  }
  return process.env[value] || value;
}

let tmpHome: string;

function logPath(): string {
  return path.join(tmpHome, ".pi", "agent", "extensions", "neuralwatt-mcr.log");
}

function readLog(): string {
  try {
    return fs.readFileSync(logPath(), "utf-8");
  } catch {
    return "";
  }
}

const MCR_LOADED_SENTINEL = Symbol.for("pi-neuralwatt-provider.mcr-loaded");

let extDefault: (pi: MockPi) => void;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nw-mcr-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  fs.mkdirSync(path.join(tmpHome, ".pi", "agent", "extensions"), {
    recursive: true,
  });
  const mod = await import("../neuralwatt-mcr.ts");
  extDefault = mod.default;
});

beforeEach(() => {
  delete process.env.X_NW_CONVERSATION_ID;
  delete process.env.X_NW_MCR_EXT_VERSION;
  delete (globalThis as any)[MCR_LOADED_SENTINEL];
  // Chad's v2.4.0 dual-instance guard uses a separate sentinel on globalThis.
  // If we don't clear it, the second test's chadFactory(proxy) call sees the
  // sentinel from the first test and returns early — no handlers, no env-var
  // seeds, no provider registration from Chad's side.
  delete (globalThis as any).__NEURALWATT_MCR_ACTIVE__;
  try {
    fs.rmSync(logPath());
  } catch {
    // no log yet
  }
});

afterEach(() => {
  delete process.env.X_NW_CONVERSATION_ID;
  delete process.env.X_NW_MCR_EXT_VERSION;
  delete (globalThis as any)[MCR_LOADED_SENTINEL];
  delete (globalThis as any).__NEURALWATT_MCR_ACTIVE__;
});

describe("provider registration", () => {
  it("re-registers our provider with api: neuralwatt and streamSimple after Chad's factory", async () => {
    const pi = makeMockPi();
    extDefault(pi);

    const cfg = pi.providers["neuralwatt"];
    expect(cfg).toBeTruthy();
    // Our provider registration wins — api is "neuralwatt", not "openai-completions"
    expect(cfg.api).toBe("neuralwatt");
    expect(cfg.streamSimple).toBeTruthy();
    // baseUrl and models are present (our full provider)
    expect(cfg.baseUrl).toBe("https://api.neuralwatt.com/v1");
    expect(Array.isArray(cfg.models)).toBe(true);
  });

  it("$-prefixes apiKey and header env-var names", async () => {
    const pi = makeMockPi();
    extDefault(pi);

    const cfg = pi.providers["neuralwatt"];
    expect(cfg.apiKey).toBe("$NEURALWATT_API_KEY");
    expect(cfg.headers["X-NW-Conversation-ID"]).toBe("$X_NW_CONVERSATION_ID");
    expect(cfg.headers["X-NW-MCR-Ext-Version"]).toBe("$X_NW_MCR_EXT_VERSION");
  });

  it("seeds X_NW_CONVERSATION_ID so the header resolves to a real value on the first request", async () => {
    const pi = makeMockPi();
    extDefault(pi);

    const headerName = pi.providers["neuralwatt"].headers["X-NW-Conversation-ID"];
    const resolved = resolveConfigValue(headerName);
    expect(resolved).not.toBe("X_NW_CONVERSATION_ID");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("upgrades the env var to Pi's stable session id on session_start", async () => {
    const pi = makeMockPi();
    extDefault(pi);
    const headerName = pi.providers["neuralwatt"].headers["X-NW-Conversation-ID"];

    const before = resolveConfigValue(headerName);

    const sessionStartHandlers = pi.handlers.get("session_start")!;
    await sessionStartHandlers[0]({}, makeCtx("neuralwatt/glm-5.1-long"));

    const after = resolveConfigValue(headerName);
    expect(after).toBe("sess-test-1234");
    expect(after).not.toBe(before);
  });
});

describe("registerProvider proxy", () => {
  it("intercepts Chad's registerProvider to strip baseUrl/api/models and $-prefix env vars", async () => {
    const pi = makeMockPi();
    extDefault(pi);

    // The proxy intercepted Chad's registerProvider call — look at the
    // intermediate calls (before our re-registration overwrites it).
    // Chad's call should be the second-to-last, with stripped fields.
    const neuralwattCalls = pi.registeredProviders.filter(
      (r) => r.name === "neuralwatt",
    );
    // At least: index.ts initial + Chad (via proxy, stripped) + our re-registration
    expect(neuralwattCalls.length).toBeGreaterThanOrEqual(2);

    // The proxy call (the one before our final re-registration) should have
    // only apiKey + headers
    const proxyCall = neuralwattCalls[neuralwattCalls.length - 2];
    expect(proxyCall.config.baseUrl).toBeUndefined();
    expect(proxyCall.config.api).toBeUndefined();
    expect(proxyCall.config.models).toBeUndefined();
    expect(proxyCall.config.apiKey).toBe("$NEURALWATT_API_KEY");
  });
});

describe("context handler: isMCRModel-first guard", () => {
  it("filters non-MCR models silently — no no_session_fp log noise", async () => {
    const pi = makeMockPi();
    extDefault(pi);
    const contextHandlers = pi.handlers.get("context")!;

    const ret = await contextHandlers[0](
      { messages: [{ type: "user" }, { type: "assistant" }] },
      makeCtx("deepseek-v4-pro"),
    );

    expect(ret).toBeUndefined();
    const log = readLog();
    expect(log).not.toContain("no_session_fp");
    expect(log).not.toContain("context_skip");
  });

  it("still logs no_session_fp for an MCR model with no session fp yet", async () => {
    const pi = makeMockPi();
    extDefault(pi);
    const contextHandlers = pi.handlers.get("context")!;

    await contextHandlers[0](
      { messages: [{ type: "user" }] },
      makeCtx("neuralwatt/glm-5.1-long"),
    );

    const log = readLog();
    expect(log).toContain("no_session_fp");
  });
});

describe("turn_end SSE bridge handler", () => {
  it("registers a turn_end handler", async () => {
    const pi = makeMockPi();
    extDefault(pi);

    const turnEndHandlers = pi.handlers.get("turn_end");
    expect(turnEndHandlers).toBeTruthy();
    expect(turnEndHandlers!.length).toBeGreaterThan(0);
  });

  it("resets bridge state on session_start", async () => {
    const pi = makeMockPi();
    extDefault(pi);

    const sessionStartHandlers = pi.handlers.get("session_start")!;
    // Chad's session_start + our bridge reset = at least 2 handlers
    expect(sessionStartHandlers.length).toBeGreaterThanOrEqual(2);
  });
});

describe("setStatus intercept: empty-string translation", () => {
  // Chad writes "" for empty/cleared states (no sessionFp, no energy).
  // In pi's extension model, "" occupies a footer status slot with no
  // visible content (producing a blank line), while undefined frees it.
  // The intercept in neuralwatt-mcr.ts translates "" → undefined so
  // Chad's empty-state writes don't leave ghost slots.

  function makeTrackedUI() {
    const calls: Array<{ key: string; text: string | undefined }> = [];
    return {
      calls,
      setStatus(key: string, text: string | undefined) {
        calls.push({ key, text });
      },
    };
  }

  function makeCtxWithUI(modelId: string, ui: any) {
    return {
      model: { id: modelId },
      sessionManager: { getSessionId: () => "sess-test-1234" },
      ui,
    };
  }

  it("translates Chad's empty-string writes to undefined for intercepted keys", async () => {
    const pi = makeMockPi();
    extDefault(pi);
    const ui = makeTrackedUI();

    // Run all session_start handlers to install the intercept
    const handlers = pi.handlers.get("session_start")!;
    for (const h of handlers) {
      await h({}, makeCtxWithUI("neuralwatt/glm-5.1-long", ui));
    }

    // Now simulate Chad's updateStatusBar writing "" for empty states
    ui.setStatus("nw-mcr", "");
    ui.setStatus("nw-energy", "");

    // The intercept should have translated "" → undefined for intercepted keys
    const mcrCalls = ui.calls.filter((c) => c.key === "nw-mcr");
    const energyCalls = ui.calls.filter((c) => c.key === "nw-energy");

    // There should be at least one call per key where text is undefined
    // (either from the intercept's translation or from our explicit clear)
    const mcrEmpty = mcrCalls.filter((c) => c.text === undefined);
    const energyEmpty = energyCalls.filter((c) => c.text === undefined);
    expect(mcrEmpty.length).toBeGreaterThanOrEqual(1);
    expect(energyEmpty.length).toBeGreaterThanOrEqual(1);

    // No "" should remain in the final call for each intercepted key
    const lastMcr = mcrCalls[mcrCalls.length - 1];
    const lastEnergy = energyCalls[energyCalls.length - 1];
    expect(lastMcr.text).not.toBe("");
    expect(lastEnergy.text).not.toBe("");
  });

  it("passes through non-intercepted keys unchanged", async () => {
    const pi = makeMockPi();
    extDefault(pi);
    const ui = makeTrackedUI();

    const handlers = pi.handlers.get("session_start")!;
    for (const h of handlers) {
      await h({}, makeCtxWithUI("neuralwatt/glm-5.1-long", ui));
    }

    // Non-intercepted keys should pass through to the real setStatus
    ui.setStatus("other-ext", "visible");
    ui.setStatus("other-ext", "");
    ui.setStatus("other-ext", undefined);

    const otherCalls = ui.calls.filter((c) => c.key === "other-ext");
    expect(otherCalls).toEqual([
      { key: "other-ext", text: "visible" },
      { key: "other-ext", text: "" },
      { key: "other-ext", text: undefined },
    ]);
  });

  it("suppresses Chad's non-empty status writes for intercepted keys", async () => {
    const pi = makeMockPi();
    extDefault(pi);
    const ui = makeTrackedUI();

    const handlers = pi.handlers.get("session_start")!;
    for (const h of handlers) {
      await h({}, makeCtxWithUI("neuralwatt/glm-5.1-long", ui));
    }

    // Non-empty writes for intercepted keys are suppressed (index.ts
    // handles display via its widget)
    ui.setStatus("nw-mcr", "MCR abc12345 | drop<5");
    ui.setStatus("nw-energy", "⚡ 1.5J");

    const mcrNonEmpty = ui.calls.filter(
      (c) => c.key === "nw-mcr" && c.text !== undefined && c.text !== "",
    );
    const energyNonEmpty = ui.calls.filter(
      (c) => c.key === "nw-energy" && c.text !== undefined && c.text !== "",
    );
    expect(mcrNonEmpty.length).toBe(0);
    expect(energyNonEmpty.length).toBe(0);
  });

  it("clears Chad's empty-string entries left by session_start handler gap", async () => {
    // Chad's session_start handler runs before the intercept is installed,
    // so his setStatus("nw-mcr", "") and setStatus("nw-energy", "") hit
    // the real setStatus. Our handler must clean those up with undefined.
    const pi = makeMockPi();
    extDefault(pi);
    const ui = makeTrackedUI();

    // Simulate the sequence: Chad's handler writes "", then our handler
    // installs the intercept and cleans up. Since we can't control
    // handler order in the mock, we verify the end state: after all
    // session_start handlers, the last write for nw-mcr/nw-energy
    // must be undefined (not "").
    const handlers = pi.handlers.get("session_start")!;
    for (const h of handlers) {
      await h({}, makeCtxWithUI("neuralwatt/glm-5.1-long", ui));
    }

    const mcrCalls = ui.calls.filter((c) => c.key === "nw-mcr");
    const energyCalls = ui.calls.filter((c) => c.key === "nw-energy");

    // The last call for each intercepted key must be undefined
    const lastMcr = mcrCalls[mcrCalls.length - 1];
    const lastEnergy = energyCalls[energyCalls.length - 1];
    expect(lastMcr).toBeDefined();
    expect(lastEnergy).toBeDefined();
    expect(lastMcr.text).toBeUndefined();
    expect(lastEnergy.text).toBeUndefined();
  });

  it("clears Chad's keys before uninstalling on session_shutdown", async () => {
    const pi = makeMockPi();
    extDefault(pi);
    const ui = makeTrackedUI();

    // Install intercept first
    const startHandlers = pi.handlers.get("session_start")!;
    for (const h of startHandlers) {
      await h({}, makeCtxWithUI("neuralwatt/glm-5.1-long", ui));
    }

    // Now run session_shutdown handlers
    const shutdownHandlers = pi.handlers.get("session_shutdown")!;
    for (const h of shutdownHandlers) {
      await h({}, makeCtxWithUI("neuralwatt/glm-5.1-long", ui));
    }

    // After shutdown, there should be undefined calls for the intercepted keys
    // (our handler clears them before uninstalling the intercept)
    const mcrCalls = ui.calls.filter((c) => c.key === "nw-mcr");
    const energyCalls = ui.calls.filter((c) => c.key === "nw-energy");

    const mcrUndefinedCalls = mcrCalls.filter((c) => c.text === undefined);
    const energyUndefinedCalls = energyCalls.filter((c) => c.text === undefined);
    expect(mcrUndefinedCalls.length).toBeGreaterThanOrEqual(1);
    expect(energyUndefinedCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("restores original setStatus after session_shutdown", async () => {
    const pi = makeMockPi();
    extDefault(pi);
    const ui = makeTrackedUI();

    const startHandlers = pi.handlers.get("session_start")!;
    for (const h of startHandlers) {
      await h({}, makeCtxWithUI("neuralwatt/glm-5.1-long", ui));
    }

    // After session_start, setStatus should be intercepted (not identity)
    expect(ui.setStatus.name).toBe("interceptedSetStatus");

    const shutdownHandlers = pi.handlers.get("session_shutdown")!;
    for (const h of shutdownHandlers) {
      await h({}, makeCtxWithUI("neuralwatt/glm-5.1-long", ui));
    }

    // After shutdown, setStatus should be restored to the original
    expect(ui.setStatus.name).not.toBe("interceptedSetStatus");
  });

  it("re-installs intercept when ctx.ui object changes between sessions", async () => {
    const pi = makeMockPi();
    extDefault(pi);

    const ui1 = makeTrackedUI();
    const ui2 = makeTrackedUI();

    // First session
    const startHandlers = pi.handlers.get("session_start")!;
    for (const h of startHandlers) {
      await h({}, makeCtxWithUI("neuralwatt/glm-5.1-long", ui1));
    }
    expect(ui1.setStatus.name).toBe("interceptedSetStatus");

    // Shutdown
    const shutdownHandlers = pi.handlers.get("session_shutdown")!;
    for (const h of shutdownHandlers) {
      await h({}, makeCtxWithUI("neuralwatt/glm-5.1-long", ui1));
    }

    // Second session with a new ui object (simulates runner.setUIContext swap)
    for (const h of startHandlers) {
      await h({}, makeCtxWithUI("neuralwatt/glm-5.1-long", ui2));
    }
    expect(ui2.setStatus.name).toBe("interceptedSetStatus");

    // Verify that writes to the new ui object are also intercepted
    ui2.setStatus("nw-mcr", "");
    const mcrCalls = ui2.calls.filter((c) => c.key === "nw-mcr");
    const lastMcr = mcrCalls[mcrCalls.length - 1];
    expect(lastMcr.text).toBeUndefined();
  });
});

describe("double-load sentinel", () => {
  it("skips Chad's factory but still re-registers our provider when sentinel is set", async () => {
    (globalThis as any)[MCR_LOADED_SENTINEL] = true;

    const pi = makeMockPi();
    extDefault(pi);

    // Our provider is still registered (re-registration runs regardless)
    const cfg = pi.providers["neuralwatt"];
    expect(cfg).toBeTruthy();
    expect(cfg.api).toBe("neuralwatt");
    expect(cfg.streamSimple).toBeTruthy();

    // No context/compaction handlers from Chad's factory (skipped)
    expect(pi.handlers.get("context")).toBeUndefined();
    expect(pi.handlers.get("session_before_compact")).toBeUndefined();

    // But our turn_end bridge handler is still registered
    expect(pi.handlers.get("turn_end")).toBeTruthy();
  });
});
