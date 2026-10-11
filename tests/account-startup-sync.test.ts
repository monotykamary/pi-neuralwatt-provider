/**
 * Startup account poll (/quota + /usage/summary + /usage/by-model), deduped
 * with the quiet-sync policy: interactive sessions only, never without a key,
 * one process per 2 minute window, everyone else renders the on-disk snapshot
 * (cache/neuralwatt-account.json). Turn-triggered polls keep their cadence
 * and refresh the snapshot.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyFingerprint, syncLockPath } from "../sync-policy";

const KEY = "sk-account-sync-test";
const MINUTE = 60 * 1000;

let home: string;
let accountPath: string;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

function setupHome(config: Record<string, unknown> = {}): void {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-neuralwatt-account-"));
  accountPath = path.join(home, "cache", "neuralwatt-account.json");
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
  vi.stubEnv("PI_PROVIDER_SYNC_TTL_MS", "");
  fs.mkdirSync(path.join(home, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(home, "extensions", "neuralwatt.json"), JSON.stringify({
    energy: "off", quota: "statusbar", carbon: "off", mcr: "off", ...config,
  }));
  // Fresh model cache with sidecar so the model sync stays quiet.
  fs.mkdirSync(path.join(home, "cache"), { recursive: true });
  const modelsPath = path.join(home, "cache", "neuralwatt-models.json");
  fs.writeFileSync(modelsPath, JSON.stringify([{ id: "kimi-k3", name: "Kimi", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 131072 }]));
  fs.writeFileSync(path.join(home, "cache", "neuralwatt-models.sync.json"), JSON.stringify({ version: 1, keyFingerprint: keyFingerprint(KEY) }));
}

const quota = (credits: number) => ({
  balance: { credits_remaining_usd: credits, total_credits_usd: 20, credits_used_usd: 20 - credits, accounting_method: "energy" },
  usage: { lifetime: { cost_usd: 0, requests: 0, tokens: 0, energy_kwh: 0 }, current_month: { cost_usd: 0, requests: 0, tokens: 0, energy_kwh: 0 } },
  limits: { overage_limit_usd: null, rate_limit_tier: "default" },
  subscription: null,
  key: { name: null, allowance: null },
});

function writeSnapshot(ageMs: number, snapshot: Record<string, unknown>, fingerprintKey = KEY): void {
  fs.writeFileSync(accountPath, JSON.stringify({ version: 1, keyFingerprint: keyFingerprint(fingerprintKey), fetchedAt: Date.now() - ageMs, ...snapshot }));
  fs.writeFileSync(accountPath.replace(/\.json$/, ".sync.json"), JSON.stringify({ version: 1, keyFingerprint: keyFingerprint(fingerprintKey) }));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(accountPath, t, t);
}

function stubFetch() {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/quota")) return Response.json(quota(12.5));
    // 1 kWh consumed, 0.2 of it flex, 0.93 charged → multiplier 0.65.
    if (url.includes("/usage/summary")) return Response.json({ accounting_method: "energy", totals: { energy_kwh_consumed: 1, energy_kwh_charged: 0.93 } });
    if (url.includes("/usage/by-model")) return Response.json({ products: [{ requested_model: "kimi-k3-flex", energy_kwh: 0.2 }] });
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const accountCalls = (fetch: ReturnType<typeof stubFetch>) =>
  fetch.mock.calls.map(([url]) => String(url)).filter((url) => /\/(quota|usage\/)/.test(url));

async function loadExtension(opts: { hasUI?: boolean; apiKey?: string | undefined; branch?: unknown[] } = {}) {
  vi.resetModules();
  const mod = await import("../index");
  const handlers = new Map<string, (...args: any[]) => any>();
  mod.default({
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerProvider: () => {},
    registerCommand: () => {},
    appendEntry: () => {},
    events: { emit: () => {} },
  } as any);
  const setStatus = vi.fn();
  const apiKey = "apiKey" in opts ? opts.apiKey : KEY;
  const ctx = {
    hasUI: opts.hasUI ?? true,
    model: { provider: "neuralwatt", id: "kimi-k3" },
    modelRegistry: { getApiKeyForProvider: async () => apiKey },
    sessionManager: { getBranch: () => opts.branch ?? [] },
    ui: { setStatus, setWidget: () => {}, notify: () => {}, theme: { fg: (_c: string, t: string) => t } },
  };
  const startSession = () => handlers.get("session_start")!({ type: "session_start" }, ctx);
  const quotaShown = () => setStatus.mock.calls.some(([key, text]) => key === "neuralwatt-quota" && typeof text === "string" && text.includes("payg"));
  return { mod, handlers, ctx, startSession, quotaShown };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("startup account poll", () => {
  it("polls once in an interactive session and writes a key-scoped snapshot", async () => {
    setupHome();
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(ext.quotaShown()).toBe(true));
    await settle();
    expect(accountCalls(fetch)).toHaveLength(3);
    const raw = fs.readFileSync(accountPath, "utf8");
    expect(raw).not.toContain(KEY);
    const snapshot = JSON.parse(raw);
    expect(snapshot.keyFingerprint).toBe(keyFingerprint(KEY));
    expect(snapshot.quota.balance.credits_remaining_usd).toBe(12.5);
    expect(snapshot.flexMultiplier).toBeCloseTo(0.65);
    expect(fs.existsSync(syncLockPath(accountPath))).toBe(false);
  });

  it("renders a fresh snapshot from another process without polling", async () => {
    setupHome();
    writeSnapshot(30 * 1000, { quota: quota(12.5), flexMultiplier: 0.5 });
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(ext.quotaShown()).toBe(true));
    await settle();
    expect(accountCalls(fetch)).toHaveLength(0);
    expect(ext.mod.effectiveFlexDiscountPct()).toBe(50);
  });

  it("re-polls once the snapshot is older than the 2 minute window", async () => {
    setupHome();
    writeSnapshot(5 * MINUTE, { quota: quota(1) });
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(accountCalls(fetch)).toHaveLength(3));
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(accountPath, "utf8")).quota.balance.credits_remaining_usd).toBe(12.5));
  });

  it("never adopts or trusts a snapshot fetched with another key", async () => {
    setupHome();
    writeSnapshot(10 * 1000, { quota: quota(1) }, "someone-elses-key");
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(accountCalls(fetch)).toHaveLength(3));
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(accountPath, "utf8")).keyFingerprint).toBe(keyFingerprint(KEY)));
  });

  it("does not poll in print mode / child agents (no UI), but adopts the measured flex multiplier", async () => {
    setupHome();
    writeSnapshot(10 * MINUTE, { quota: quota(12.5), flexMultiplier: 0.5 });
    const fetch = stubFetch();
    const ext = await loadExtension({ hasUI: false });
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(ext.mod.effectiveFlexDiscountPct()).toBe(50);
  });

  it("never polls without an API key", async () => {
    setupHome();
    const fetch = stubFetch();
    const ext = await loadExtension({ apiKey: undefined });
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(accountPath)).toBe(false);
  });

  it("skips the poll entirely when quota display is off", async () => {
    setupHome({ quota: "off" });
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips while another process holds the account lock", async () => {
    setupHome();
    writeSnapshot(5 * MINUTE, { quota: quota(12.5) });
    fs.writeFileSync(syncLockPath(accountPath), JSON.stringify({ pid: 999999, token: "other-process" }));
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(ext.quotaShown()).toBe(true)); // renders the last snapshot meanwhile
    await settle();
    expect(accountCalls(fetch)).toHaveLength(0);
  });

  it("turn-triggered polls (agent_settled) refresh the shared snapshot", async () => {
    setupHome();
    writeSnapshot(30 * 1000, { quota: quota(1) });
    const fetch = stubFetch();
    const branch = [{ type: "custom", customType: "neuralwatt-energy", data: { energy_joules: 10, cost_usd: 0.01 } }];
    const ext = await loadExtension({ branch });
    await ext.startSession();
    await settle();
    expect(accountCalls(fetch)).toHaveLength(0);
    await ext.handlers.get("agent_settled")!({}, ext.ctx);
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(accountPath, "utf8")).quota.balance.credits_remaining_usd).toBe(12.5));
    expect(accountCalls(fetch).filter((url) => url.endsWith("/quota"))).toHaveLength(1);
  });

  it("turn-triggered polls never run without an API key", async () => {
    setupHome();
    const fetch = stubFetch();
    const branch = [{ type: "custom", customType: "neuralwatt-energy", data: { energy_joules: 10, cost_usd: 0.01 } }];
    const ext = await loadExtension({ apiKey: undefined, branch });
    await ext.startSession();
    await settle();
    await ext.handlers.get("agent_settled")!({}, ext.ctx);
    await ext.handlers.get("session_tree")!({}, ext.ctx);
    await settle();
    expect(fetch).not.toHaveBeenCalled();
  });
});
