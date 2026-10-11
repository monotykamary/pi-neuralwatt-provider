/**
 * Quiet startup sync, end to end through the extension's real session_start
 * handler: the live /models catalog is fetched only with a key, only when the
 * disk cache is stale (or the key changed), only by one process at a time, and
 * never on the session_start critical path.
 *
 * Porting: only the "Provider specifics" block below differs between
 * pi-*-provider repos.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyFingerprint, syncLockPath, syncMetaPath } from "../sync-policy";
import embeddedModels from "../models.json" with { type: "json" };

// ─── Provider specifics ───────────────────────────────────────────────────────
const PROVIDER_ID = "neuralwatt";
const LIVE_ONLY_ID = "live-only-test-model";
/** A minimal successful /models response containing LIVE_ONLY_ID. */
const liveModelsResponse = () => Response.json({
  data: [{
    id: LIVE_ONLY_ID,
    metadata: { limits: { max_context_length: 65536 } },
  }],
});
/**
 * registerProvider calls without a live refresh: one at load plus the
 * identity-preserving re-registration in every session_start.
 */
const STATIC_REGISTRATIONS = 2;
/**
 * Session context. hasUI: false (print mode) keeps the interactive-only
 * startup account poll (/quota, /usage) out of these model-sync tests; it is
 * covered by tests/account-startup-sync.test.ts.
 */
const sessionContext = (getApiKeyForProvider: () => Promise<string | undefined>) => ({
  hasUI: false,
  model: undefined,
  modelRegistry: { getApiKeyForProvider },
  sessionManager: { getBranch: () => [] },
  ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {}, theme: { fg: (_c: string, t: string) => t } },
});
// ──────────────────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const KEY = "sk-quiet-sync-test";

let home: string;
let cachePath: string;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

function setupHome(): void {
  home = fs.mkdtempSync(path.join(os.tmpdir(), `pi-${PROVIDER_ID}-sync-`));
  cachePath = path.join(home, "cache", `${PROVIDER_ID}-models.json`);
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
  vi.stubEnv("PI_PROVIDER_SYNC_TTL_MS", "");
}

function writeCache(ageMs: number, models: unknown[] = embeddedModels, fingerprintKey: string | null = KEY): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(models));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(cachePath, t, t);
  if (fingerprintKey !== null) {
    fs.writeFileSync(syncMetaPath(cachePath), JSON.stringify({ version: 1, keyFingerprint: keyFingerprint(fingerprintKey) }));
  }
}

function stubFetch(impl: () => Promise<Response> = async () => liveModelsResponse()) {
  const fetch = vi.fn(impl);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Load the extension fresh (module-level cache paths read PI_CODING_AGENT_DIR). */
async function loadExtension() {
  vi.resetModules();
  const mod = await import("../index");
  const handlers = new Map<string, (...args: any[]) => any>();
  const registrations: Array<{ models: Array<{ id: string }> }> = [];
  mod.default({
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerProvider: (_id: string, config: any) => registrations.push(config),
    registerCommand: () => {},
    appendEntry: () => {},
    events: { emit: () => {} },
  } as any);
  const getApiKeyForProvider = vi.fn(async (): Promise<string | undefined> => KEY);
  const startSession = () => handlers.get("session_start")!({ type: "session_start" }, sessionContext(getApiKeyForProvider));
  return { handlers, registrations, getApiKeyForProvider, startSession };
}

/** Let the fire-and-forget revalidation chain run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const hasLiveModel = (config: { models: Array<{ id: string }> } | undefined) => !!config?.models.some((m) => m.id === LIVE_ONLY_ID);

describe("quiet startup sync", () => {
  it("skips the live fetch while the disk cache is fresher than the TTL", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await settle();
    expect(ext.getApiKeyForProvider).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(ext.registrations).toHaveLength(STATIC_REGISTRATIONS);
  });

  it("revalidates a stale cache once, hot-swaps the catalog and rewrites the cache", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    // Cache stays a plain JSON array so older extension versions still read it.
    expect(Array.isArray(cached)).toBe(true);
    expect(cached.some((m: { id: string }) => m.id === LIVE_ONLY_ID)).toBe(true);
    expect(Date.now() - fs.statSync(cachePath).mtimeMs).toBeLessThan(60_000);
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
    const meta = fs.readFileSync(syncMetaPath(cachePath), "utf8");
    expect(meta).not.toContain(KEY);
    expect(JSON.parse(meta).keyFingerprint).toBe(keyFingerprint(KEY));

    // A second session in the same process (/new) is now inside the TTL.
    await ext.startSession();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never touches the network without an API key", async () => {
    setupHome();
    const fetch = stubFetch();
    const ext = await loadExtension();
    ext.getApiKeyForProvider.mockResolvedValue(undefined);
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
    expect(ext.registrations).toHaveLength(STATIC_REGISTRATIONS);
  });

  it("skips when another process holds the revalidation lock", async () => {
    setupHome();
    writeCache(2 * HOUR);
    fs.writeFileSync(syncLockPath(cachePath), JSON.stringify({ pid: 999999, token: "other-process" }));
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(syncLockPath(cachePath), "utf8")).token).toBe("other-process");
  });

  it("reclaims a stale lock left by a crashed process", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const lockPath = syncLockPath(cachePath);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "crashed" }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockPath, old, old);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("forces a revalidation when the API key changed, even inside the TTL", async () => {
    setupHome();
    writeCache(60 * 1000, embeddedModels, "previous-key");
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("revalidates once when the cache predates the sync sidecar (older extension version)", async () => {
    setupHome();
    writeCache(60 * 1000, embeddedModels, null);
    const fetch = stubFetch();
    const ext = await loadExtension();
    expect(ext.registrations[0].models.length).toBeGreaterThan(0); // old cache is still served
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not throw or fetch when the cache dir is unwritable", async () => {
    setupHome();
    fs.writeFileSync(path.join(home, "cache"), "a file where the cache dir should be");
    const fetch = stubFetch();
    const ext = await loadExtension();
    await expect(ext.startSession()).resolves.toBeUndefined();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(ext.registrations).toHaveLength(STATIC_REGISTRATIONS);
  });

  it("does not await the network in session_start", async () => {
    setupHome();
    writeCache(2 * HOUR);
    let release!: () => void;
    const fetch = stubFetch(() => new Promise<Response>((resolve) => { release = () => resolve(liveModelsResponse()); }));
    const ext = await loadExtension();
    const outcome = await Promise.race([
      Promise.resolve(ext.startSession()).then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
    ]);
    expect(outcome).toBe("returned");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    release();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
  });

  it("swallows API key resolution failures (no unhandled rejection)", async () => {
    setupHome();
    const fetch = stubFetch();
    const ext = await loadExtension();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      ext.getApiKeyForProvider.mockRejectedValue(new Error("keychain locked"));
      await ext.startSession();
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("backs off after a failed fetch instead of retrying in every new process", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const fetch = stubFetch(async () => new Response("unauthorized", { status: 401 }));
    let ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await settle();
    ext = await loadExtension(); // next pi process
    await ext.startSession();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("adopts a cache refreshed by another process without fetching", async () => {
    setupHome();
    writeCache(30 * 60 * 1000);
    const fetch = stubFetch();
    const ext = await loadExtension();
    // Another pi process revalidated after this one started.
    const refreshed = [...embeddedModels, { ...embeddedModels[0], id: LIVE_ONLY_ID }];
    fs.writeFileSync(cachePath, JSON.stringify(refreshed));
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("PI_PROVIDER_SYNC_TTL_MS=0 revalidates on every session start", async () => {
    setupHome();
    vi.stubEnv("PI_PROVIDER_SYNC_TTL_MS", "0");
    writeCache(0);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  });
});
