// Tests for the Neuralwatt MCR Pi extension.
//
// The extension is shipped as a single .ts file that Pi loads at runtime
// (types are erased). These tests drive the real extension with a mock `pi`
// object, capturing the handlers and provider config it registers, and assert
// the two behaviours hardened in tools#38:
//
//   1. The X-NW-Conversation-ID header is wired so the SDK resolves it from
//      `process.env` live per request (env-var-NAME-as-value mechanism).
//   2. The `context` handler filters non-MCR models FIRST, silently — no
//      `no_session_fp` log noise for deepseek/GLM/Kimi non-MCR turns.
//
// We run each test in an isolated $HOME so the extension's append-only log
// file is observable and does not leak across tests.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Handler = (event: any, ctx: any) => any;

interface MockPi {
  handlers: Map<string, Handler>;
  providers: Record<string, any>;
  on: (event: string, handler: Handler) => void;
  registerProvider: (name: string, config: any) => void;
  appendEntry: (_type: string, _data: any) => void;
}

function makeMockPi(): MockPi {
  const handlers = new Map<string, Handler>();
  const providers: Record<string, any> = {};
  return {
    handlers,
    providers,
    on(event, handler) {
      handlers.set(event, handler);
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
// Pi's resolve-config-value strips the leading `$` and resolves
// `process.env[name]`. If the env var is unset, it falls back to the raw
// value (without `$`). This mirrors what the SDK does with `$`-prefixed
// header values registered via `pi.registerProvider({ headers })`.
function resolveConfigValue(value: string): string {
  if (value.startsWith("$")) {
    const envName = value.slice(1);
    return process.env[envName] || envName;
  }
  return process.env[value] || value;
}

let tmpHome: string;
let extDefault: (pi: MockPi) => void;

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

async function loadExtension(): Promise<(pi: MockPi) => void> {
  return extDefault;
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nw-mcr-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  fs.mkdirSync(path.join(tmpHome, ".pi", "agent", "extensions"), {
    recursive: true,
  });
  const mod = await import("../neuralwatt-mcr.ts");
  extDefault = mod.default as (pi: MockPi) => void;
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
    (await loadExtension())(pi);

    const cfg = pi.providers["neuralwatt"];
    expect(cfg).toBeTruthy();
    // Header VALUES are $-prefixed env-var NAMES (Pi's current convention).
    expect(cfg.headers["X-NW-Conversation-ID"]).toBe("$X_NW_CONVERSATION_ID");
    expect(cfg.headers["X-NW-MCR-Ext-Version"]).toBe("$X_NW_MCR_EXT_VERSION");
  });

  it("seeds X_NW_CONVERSATION_ID so the header resolves to a real value on the first request", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);

    const headerName = pi.providers["neuralwatt"].headers["X-NW-Conversation-ID"];
    const resolved = resolveConfigValue(headerName);
    // Resolves to the seeded value, NOT the literal env-var name.
    expect(resolved).not.toBe("X_NW_CONVERSATION_ID");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("upgrades the env var to Pi's stable session id on session_start, and the header re-reads it live", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const headerName = pi.providers["neuralwatt"].headers["X-NW-Conversation-ID"];

    const before = resolveConfigValue(headerName);

    const sessionStart = pi.handlers.get("session_start")!;
    await sessionStart({}, makeCtx("neuralwatt/glm-5.1-long"));

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
    (await loadExtension())(pi);
    const context = pi.handlers.get("context")!;

    const ret = await context(
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
    (await loadExtension())(pi);
    const context = pi.handlers.get("context")!;

    await context(
      { messages: [{ type: "user" }] },
      makeCtx("neuralwatt/glm-5.1-long"),
    );

    const log = readLog();
    expect(log).toContain("no_session_fp");
  });
});
