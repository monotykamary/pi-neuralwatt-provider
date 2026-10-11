/**
 * Unit tests for sync-policy.ts — the provider-agnostic quiet startup sync
 * policy (TTL, key fingerprint, failure backoff, cross-process lock).
 *
 * Provider-agnostic: copied verbatim into every pi-*-provider repo alongside
 * sync-policy.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SYNC_TTL_MS,
  SYNC_TTL_ENV,
  acquireModelSync,
  cacheChangedSinceLoad,
  keyFingerprint,
  markCacheLoaded,
  planModelSync,
  resolveSyncTtlMs,
  syncLockPath,
  syncMetaPath,
  writeFileAtomic,
} from "../sync-policy";

const HOUR = 60 * 60 * 1000;
const KEY = "sk-test-secret-key";

let dir: string;
let cachePath: string;

beforeEach(() => {
  vi.stubEnv(SYNC_TTL_ENV, "");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-policy-"));
  cachePath = path.join(dir, "cache", "example-models.json");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeCache(ageMs: number, models: unknown = [{ id: "m" }]): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(models));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(cachePath, t, t);
}

function writeMeta(meta: Record<string, unknown>): void {
  fs.writeFileSync(syncMetaPath(cachePath), JSON.stringify({ version: 1, ...meta }));
}

function writeLock(ageMs: number, token = "someone-else"): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(syncLockPath(cachePath), JSON.stringify({ pid: 999999, token }));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(syncLockPath(cachePath), t, t);
}

describe("keyFingerprint", () => {
  it("is a stable 16-hex digest that never contains the key", () => {
    const fp = keyFingerprint(KEY);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(keyFingerprint(KEY)).toBe(fp);
    expect(keyFingerprint(`${KEY}x`)).not.toBe(fp);
    expect(fp).not.toContain(KEY);
  });
});

describe("resolveSyncTtlMs", () => {
  it("defaults to 1 hour", () => {
    expect(resolveSyncTtlMs()).toBe(DEFAULT_SYNC_TTL_MS);
    expect(DEFAULT_SYNC_TTL_MS).toBe(HOUR);
  });

  it(`honors ${SYNC_TTL_ENV} (0 = always revalidate) and ignores garbage`, () => {
    vi.stubEnv(SYNC_TTL_ENV, "0");
    expect(resolveSyncTtlMs()).toBe(0);
    vi.stubEnv(SYNC_TTL_ENV, "120000");
    expect(resolveSyncTtlMs()).toBe(120000);
    vi.stubEnv(SYNC_TTL_ENV, "-5");
    expect(resolveSyncTtlMs()).toBe(DEFAULT_SYNC_TTL_MS);
    vi.stubEnv(SYNC_TTL_ENV, "soon");
    expect(resolveSyncTtlMs()).toBe(DEFAULT_SYNC_TTL_MS);
  });

  it("prefers an explicit ttlMs over the env", () => {
    vi.stubEnv(SYNC_TTL_ENV, "0");
    expect(resolveSyncTtlMs(5000)).toBe(5000);
  });
});

describe("planModelSync", () => {
  it("never fetches without a key", () => {
    expect(planModelSync({ cachePath, apiKey: undefined })).toEqual({ fetch: false, reason: "no-key" });
    expect(planModelSync({ cachePath, apiKey: "" })).toEqual({ fetch: false, reason: "no-key" });
  });

  it("fetches when the cache is missing or corrupt", () => {
    expect(planModelSync({ cachePath, apiKey: KEY })).toEqual({ fetch: true, reason: "missing" });
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "{not json");
    expect(planModelSync({ cachePath, apiKey: KEY })).toEqual({ fetch: true, reason: "missing" });
    writeCache(0, []);
    expect(planModelSync({ cachePath, apiKey: KEY })).toEqual({ fetch: true, reason: "missing" });
  });

  it("skips inside the TTL and fetches once it expires", () => {
    writeCache(10 * 60 * 1000);
    writeMeta({ keyFingerprint: keyFingerprint(KEY) });
    expect(planModelSync({ cachePath, apiKey: KEY })).toEqual({ fetch: false, reason: "fresh" });
    writeCache(2 * HOUR);
    expect(planModelSync({ cachePath, apiKey: KEY })).toEqual({ fetch: true, reason: "stale" });
    vi.stubEnv(SYNC_TTL_ENV, "0");
    writeCache(0);
    expect(planModelSync({ cachePath, apiKey: KEY })).toEqual({ fetch: true, reason: "stale" });
  });

  it("forces a fetch when the key changed or the cache predates the sidecar", () => {
    writeCache(0);
    expect(planModelSync({ cachePath, apiKey: KEY })).toEqual({ fetch: true, reason: "key-changed" });
    writeMeta({ keyFingerprint: keyFingerprint("old-key") });
    expect(planModelSync({ cachePath, apiKey: KEY })).toEqual({ fetch: true, reason: "key-changed" });
  });

  it("forces a fetch on demand (e.g. after /login) regardless of TTL", () => {
    writeCache(0);
    writeMeta({ keyFingerprint: keyFingerprint(KEY) });
    expect(planModelSync({ cachePath, apiKey: KEY, force: true })).toEqual({ fetch: true, reason: "forced" });
  });

  it("backs off after a recent failure with the same key, unless forced", () => {
    writeCache(2 * HOUR);
    writeMeta({ keyFingerprint: keyFingerprint(KEY), failedAt: Date.now() - 1000, failedKeyFingerprint: keyFingerprint(KEY) });
    expect(planModelSync({ cachePath, apiKey: KEY })).toEqual({ fetch: false, reason: "backoff" });
    expect(planModelSync({ cachePath, apiKey: KEY, force: true }).fetch).toBe(true);
    // A different key is not held back by another key's failure.
    expect(planModelSync({ cachePath, apiKey: "new-key" })).toEqual({ fetch: true, reason: "key-changed" });
    // Backoff expires.
    writeMeta({ keyFingerprint: keyFingerprint(KEY), failedAt: Date.now() - HOUR, failedKeyFingerprint: keyFingerprint(KEY) });
    expect(planModelSync({ cachePath, apiKey: KEY })).toEqual({ fetch: true, reason: "stale" });
  });
});

describe("acquireModelSync", () => {
  it("is single-flight: a second caller skips while the lock is held", () => {
    const skipped: string[] = [];
    const first = acquireModelSync({ cachePath, apiKey: KEY });
    expect(first?.reason).toBe("missing");
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(true);
    expect(acquireModelSync({ cachePath, apiKey: KEY, onSkip: (r) => skipped.push(r) })).toBeNull();
    expect(skipped).toEqual(["locked"]);
    first!.release("aborted");
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
    expect(acquireModelSync({ cachePath, apiKey: KEY })).not.toBeNull();
  });

  it("skips while another process holds a live lock", () => {
    writeLock(1000);
    const skipped: string[] = [];
    expect(acquireModelSync({ cachePath, apiKey: KEY, onSkip: (r) => skipped.push(r) })).toBeNull();
    expect(skipped).toEqual(["locked"]);
  });

  it("reclaims a stale lock left by a crashed process", () => {
    writeLock(5 * 60 * 1000);
    const lease = acquireModelSync({ cachePath, apiKey: KEY });
    expect(lease).not.toBeNull();
    lease!.release("aborted");
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
  });

  it("never removes a lock it no longer owns", () => {
    const lease = acquireModelSync({ cachePath, apiKey: KEY, lockStaleMs: 0 })!;
    writeLock(0, "reclaimed-by-another-process");
    lease.release("aborted");
    expect(JSON.parse(fs.readFileSync(syncLockPath(cachePath), "utf8")).token).toBe("reclaimed-by-another-process");
  });

  it("records the key fingerprint on success (never the key) and the failure on error", () => {
    let lease = acquireModelSync({ cachePath, apiKey: KEY })!;
    writeCache(0);
    lease.release("fetched");
    const raw = fs.readFileSync(syncMetaPath(cachePath), "utf8");
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw)).toMatchObject({ version: 1, keyFingerprint: keyFingerprint(KEY) });
    expect(planModelSync({ cachePath, apiKey: KEY })).toEqual({ fetch: false, reason: "fresh" });

    lease = acquireModelSync({ cachePath, apiKey: KEY, force: true })!;
    lease.release("failed");
    expect(JSON.parse(fs.readFileSync(syncMetaPath(cachePath), "utf8"))).toMatchObject({
      keyFingerprint: keyFingerprint(KEY),
      failedKeyFingerprint: keyFingerprint(KEY),
    });
  });

  it("does not record a failure for an aborted fetch", () => {
    acquireModelSync({ cachePath, apiKey: KEY })!.release("aborted");
    expect(fs.existsSync(syncMetaPath(cachePath))).toBe(false);
  });

  it("fails open (null, no throw) when the cache dir is unwritable", () => {
    // A regular file where the cache directory should be: mkdir/open fail even as root.
    fs.writeFileSync(path.join(dir, "cache"), "not a directory");
    const skipped: string[] = [];
    expect(() => acquireModelSync({ cachePath, apiKey: KEY, onSkip: (r) => skipped.push(r) })).not.toThrow();
    expect(acquireModelSync({ cachePath, apiKey: KEY })).toBeNull();
    expect(skipped).toEqual(["unwritable"]);
  });

  // Real processes: children load sync-policy.ts via Node's built-in type stripping (Node >= 22.18).
  it.skipIf(!(process.features as { typescript?: unknown }).typescript)("lets exactly one of many concurrent processes fetch", async () => {
    writeCache(2 * HOUR);
    writeMeta({ keyFingerprint: keyFingerprint(KEY) });
    const modulePath = fileURLToPath(new URL("../sync-policy.ts", import.meta.url));
    // Each child: try to acquire; the winner "fetches" for 300ms, writes the
    // cache and releases. Late starters must then see a fresh cache.
    const child = `
      const { acquireModelSync, writeFileAtomic } = await import(${JSON.stringify(modulePath)});
      const [cachePath, key] = process.argv.slice(-2);
      const lease = acquireModelSync({ cachePath, apiKey: key });
      if (lease) {
        await new Promise((r) => setTimeout(r, 300));
        writeFileAtomic(cachePath, JSON.stringify([{ id: "fresh" }]));
        lease.release("fetched");
      }
      process.stdout.write(lease ? "fetch" : "skip");
    `;
    const run = () => new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["--input-type=module", "-e", child, cachePath, KEY], (err, stdout) => err ? reject(err) : resolve(stdout));
    });
    const results = await Promise.all(Array.from({ length: 8 }, run));
    expect(results.filter((r) => r === "fetch")).toHaveLength(1);
    expect(results.filter((r) => r === "skip")).toHaveLength(7);
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
  }, 20000);
});

describe("cache helpers", () => {
  it("writeFileAtomic replaces the file without leaving temp files", () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileAtomic(cachePath, "[1]");
    writeFileAtomic(cachePath, "[2]");
    expect(fs.readFileSync(cachePath, "utf8")).toBe("[2]");
    expect(fs.readdirSync(path.dirname(cachePath))).toEqual([path.basename(cachePath)]);
  });

  it("cacheChangedSinceLoad spots a cache rewritten by another process", () => {
    writeCache(HOUR);
    markCacheLoaded(cachePath);
    expect(cacheChangedSinceLoad(cachePath)).toBe(false);
    writeCache(0);
    expect(cacheChangedSinceLoad(cachePath)).toBe(true);
  });
});
