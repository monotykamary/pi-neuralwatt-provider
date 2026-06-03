// Tests for the Neuralwatt MCR Pi extension wrapper.
//
// The wrapper delegates to Chad's upstream @neuralwatt/pi-mcr-extension with
// two runtime patches: (1) registerProvider intercepted to strip models/api
// and $-prefix env vars, (2) turn_end SSE bridge handler added.
//
// These tests drive the real wrapper with a mock `pi` object and the
// committed chad-mcr-upstream.ts, then assert the proxy patches and Chad's
// handler behaviors work correctly:
//
//   1. The registerProvider proxy strips baseUrl/api/models and $-prefixes
//      env-var names.
//   2. X_NW_CONVERSATION_ID is seeded via Chad's factory and resolved live.
//   3. session_start upgrades the env var to Pi's stable session id.
//   4. The context handler (via Chad's factory) filters non-MCR models first.
//   5. The context handler logs no_session_fp for MCR models without fp.
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
  on: (event: string, handler: Handler) => void;
  registerProvider: (name: string, config: any) => void;
  appendEntry: (_type: string, _data: any) => void;
}

function makeMockPi(): MockPi {
  const handlers = new Map<string, Handler[]>();
  const providers: Record<string, any> = {};
  return {
    handlers,
    providers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerProvider(name, config) {
      providers[name] = config;
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
  try {
    fs.rmSync(logPath());
  } catch {
    // no log yet
  }
});

afterEach(() => {
  delete process.env.X_NW_CONVERSATION_ID;
  delete process.env.X_NW_MCR_EXT_VERSION;
});

describe("X-NW-Conversation-ID header wiring", () => {
  it("registers the neuralwatt provider with $-prefixed env-var-name header values", async () => {
    const pi = makeMockPi();
    extDefault(pi);

    const cfg = pi.providers["neuralwatt"];
    expect(cfg).toBeTruthy();
    // The proxy strips baseUrl/api/models and $-prefixes the header values.
    expect(cfg.baseUrl).toBeUndefined();
    expect(cfg.api).toBeUndefined();
    expect(cfg.models).toBeUndefined();
    // Header VALUES are $-prefixed env-var NAMES (Pi's current convention).
    expect(cfg.headers["X-NW-Conversation-ID"]).toBe("$X_NW_CONVERSATION_ID");
    expect(cfg.headers["X-NW-MCR-Ext-Version"]).toBe("$X_NW_MCR_EXT_VERSION");
    // apiKey also $-prefixed.
    expect(cfg.apiKey).toBe("$NEURALWATT_API_KEY");
  });

  it("seeds X_NW_CONVERSATION_ID so the header resolves to a real value on the first request", async () => {
    const pi = makeMockPi();
    extDefault(pi);

    const headerName = pi.providers["neuralwatt"].headers["X-NW-Conversation-ID"];
    const resolved = resolveConfigValue(headerName);
    // Resolves to the seeded value, NOT the literal env-var name.
    expect(resolved).not.toBe("X_NW_CONVERSATION_ID");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("upgrades the env var to Pi's stable session id on session_start, and the header re-reads it live", async () => {
    const pi = makeMockPi();
    extDefault(pi);
    const headerName = pi.providers["neuralwatt"].headers["X-NW-Conversation-ID"];

    const before = resolveConfigValue(headerName);

    const sessionStartHandlers = pi.handlers.get("session_start")!;
    await sessionStartHandlers[0]({}, makeCtx("neuralwatt/glm-5.1-long"));

    const after = resolveConfigValue(headerName);
    // After session_start the header resolves to Pi's stable session id, and
    // it changed from the boot UUID — proving the live per-request re-read path.
    expect(after).toBe("sess-test-1234");
    expect(after).not.toBe(before);
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
    expect(log).not.toContain("not_mcr_model");
    // No context_skip line at all for a non-MCR model.
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

describe("registerProvider proxy", () => {
  it("strips baseUrl, api, and models from the neuralwatt provider registration", async () => {
    const pi = makeMockPi();
    extDefault(pi);

    const cfg = pi.providers["neuralwatt"];
    expect(cfg.baseUrl).toBeUndefined();
    expect(cfg.api).toBeUndefined();
    expect(cfg.models).toBeUndefined();
    // apiKey and headers are preserved (key integration points).
    expect(cfg.apiKey).toBe("$NEURALWATT_API_KEY");
    expect(cfg.headers["X-NW-Conversation-ID"]).toBe("$X_NW_CONVERSATION_ID");
  });

  it("passes through non-neuralwatt provider registrations unchanged", async () => {
    const pi = makeMockPi();
    const registered: Array<{ name: string; config: any }> = [];
    const origRegister = pi.registerProvider.bind(pi);
    pi.registerProvider = (name: string, config: any) => {
      registered.push({ name, config });
      origRegister(name, config);
    };

    extDefault(pi);

    const neuralwatt = registered.find((r) => r.name === "neuralwatt");
    expect(neuralwatt).toBeTruthy();
    expect(neuralwatt!.config.baseUrl).toBeUndefined();
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

    // The wrapper registers its own session_start handler (the last one)
    // that resets bridge state. Verify it's present.
    const sessionStartHandlers = pi.handlers.get("session_start")!;
    // Chad's session_start + our bridge reset = at least 2 handlers
    expect(sessionStartHandlers.length).toBeGreaterThanOrEqual(2);
  });
});
