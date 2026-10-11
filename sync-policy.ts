/**
 * Quiet startup sync — shared policy for background model-catalog revalidation.
 *
 * Every pi process (interactive start, /new, /reload, `pi -p`, and every child
 * agent a fan-out tool spawns) fires `session_start`. Revalidating the live
 * `/models` catalog on each of those spams the provider API, so this module
 * decides — without any network I/O and without ever throwing — whether *this*
 * process should fetch at all:
 *
 *   1. No credentials → no fetch (serve disk cache → embedded models.json).
 *   2. Freshness window → skip while the disk cache is younger than the TTL.
 *      TTL source: the cache file's mtime. The cache is only (re)written after a
 *      successful live fetch, so mtime is "last fetched at" — and caches written
 *      by older extension versions carry it too, with no format change.
 *      Default 1 hour; override with PI_PROVIDER_SYNC_TTL_MS (0 = always).
 *   3. Forced refresh ignores the TTL: cache missing/corrupt, API key changed
 *      since the cache was fetched (compared via a salted sha256 fingerprint —
 *      never the key itself), or the caller passes `force` (e.g. after /login).
 *   4. Failure backoff → after a failed fetch with the same key, non-forced
 *      attempts wait min(5 min, TTL) so a bad key or outage is not retried by
 *      every process that starts.
 *   5. Cross-process single-flight → an atomic lock file (`open(…, "wx")`) next
 *      to the cache; whoever creates it fetches, everyone else skips and keeps
 *      serving the cache. Locks older than the stale timeout (crashed holder)
 *      are reclaimed. Any filesystem error fails open to "skip the fetch".
 *
 * Files (for a cache at `<agentDir>/cache/<provider>-models.json`):
 *   <provider>-models.json        the cache itself — unchanged plain JSON array
 *   <provider>-models.sync.json   sidecar: { version, keyFingerprint, fetchedAt, failedAt?, failedKeyFingerprint? }
 *   <provider>-models.lock        present only while one process is fetching
 *
 * Older extension versions ignore the sidecar/lock and read the cache as
 * before; a cache without a sidecar (written by an older version) is treated
 * as "fetched with an unknown key" and revalidated once (still single-flight).
 *
 * This file is provider-agnostic: it is copied verbatim into every
 * pi-*-provider repo. Keep it free of pi imports and provider specifics.
 *
 * Typical use inside a provider's revalidateModels():
 *
 *   const lease = acquireModelSync({ cachePath: CACHE_PATH, apiKey, force });
 *   if (!lease) return cacheChangedSinceLoad(CACHE_PATH) ? loadStaleModels(embedded) : null;
 *   let merged = null;
 *   try { …fetch, merge, cacheModels(merged)…; return merged; }
 *   finally { lease.release(merged ? "fetched" : signal?.aborted ? "aborted" : "failed"); }
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

/** Env override for the freshness window, shared by all pi-*-provider extensions. */
export const SYNC_TTL_ENV = "PI_PROVIDER_SYNC_TTL_MS";
export const DEFAULT_SYNC_TTL_MS = 60 * 60 * 1000;
/** A lock older than this is assumed abandoned (crashed holder). Must exceed the fetch timeout. */
export const DEFAULT_LOCK_STALE_MS = 60 * 1000;
/** Pause after a failed fetch (same key) before non-forced retries; capped at the TTL. */
export const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

/** Why this process was granted the fetch. */
export type SyncReason = "missing" | "key-changed" | "forced" | "stale";
/** Why this process must not fetch (serve cache/embedded instead). */
export type SkipReason = "no-key" | "fresh" | "backoff" | "locked" | "unwritable";
/** How a granted fetch ended; "aborted" (session replaced/shut down) records no failure. */
export type SyncOutcome = "fetched" | "failed" | "aborted";

export type SyncPlan = { fetch: true; reason: SyncReason } | { fetch: false; reason: SkipReason };

export interface ModelSyncOptions {
  /** Absolute path of the provider's disk cache, e.g. `<agentDir>/cache/<provider>-models.json`. */
  cachePath: string;
  /** Resolved credential. Falsy → never fetch. */
  apiKey: string | undefined | null;
  /** Revalidate regardless of TTL/backoff (e.g. right after /login). Still single-flight. */
  force?: boolean;
  /** Freshness window; defaults to $PI_PROVIDER_SYNC_TTL_MS, else 1 hour. */
  ttlMs?: number;
  lockStaleMs?: number;
  /** Cache validity check; defaults to "non-empty JSON array" (the models cache format). */
  isValidCache?: (data: unknown) => boolean;
  /** Clock override for tests. */
  now?: number;
  /** Optional diagnostics hook: called with the reason whenever the fetch is skipped. */
  onSkip?: (reason: SkipReason) => void;
}

export interface ModelSyncLease {
  readonly reason: SyncReason;
  /** Always call exactly once (use try/finally). Records the outcome and drops the lock. */
  release(outcome: SyncOutcome): void;
}

interface SyncMeta {
  version: 1;
  keyFingerprint?: string;
  fetchedAt?: number;
  failedAt?: number;
  failedKeyFingerprint?: string;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

/** Salted, truncated sha256 of the key: detects key changes, cannot be reversed into the key. */
export function keyFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(`pi-provider-sync\0${apiKey}`).digest("hex").slice(0, 16);
}

export function resolveSyncTtlMs(ttlMs?: number): number {
  if (typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs >= 0) return ttlMs;
  const raw = process.env[SYNC_TTL_ENV];
  const fromEnv = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_SYNC_TTL_MS;
}

/** `foo-models.json` → `foo-models` (sidecar/lock base name). */
function sidecarBase(cachePath: string): string {
  return cachePath.replace(/\.json$/i, "");
}
export const syncMetaPath = (cachePath: string): string => `${sidecarBase(cachePath)}.sync.json`;
export const syncLockPath = (cachePath: string): string => `${sidecarBase(cachePath)}.lock`;

function mtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readMeta(cachePath: string): SyncMeta | null {
  const data = readJson(syncMetaPath(cachePath));
  return data && typeof data === "object" && !Array.isArray(data) ? (data as SyncMeta) : null;
}

/**
 * Write via temp file + rename so concurrent readers in other processes never
 * observe a half-written file (a torn cache would otherwise read as "corrupt"
 * and force a refetch). Throws on failure — callers decide whether that is fatal.
 */
export function writeFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

function writeMeta(cachePath: string, meta: SyncMeta): void {
  try {
    writeFileAtomic(syncMetaPath(cachePath), JSON.stringify(meta) + "\n");
  } catch {
    // Non-fatal: worst case the next process revalidates once more.
  }
}

// ─── In-process view of the shared cache ──────────────────────────────────────

// mtime of the cache as this process last loaded/wrote it, per cache path.
const loadedCacheMtimes = new Map<string, number>();

/** Call right before reading the disk cache at startup (stat-before-read keeps races harmless). */
export function markCacheLoaded(cachePath: string): void {
  loadedCacheMtimes.set(cachePath, mtimeMs(cachePath) ?? 0);
}

/**
 * True when another process rewrote the shared cache since this process last
 * loaded it, so a long-lived session can adopt the newer catalog from disk
 * instead of fetching it again.
 */
export function cacheChangedSinceLoad(cachePath: string): boolean {
  const current = mtimeMs(cachePath);
  return current !== null && current !== loadedCacheMtimes.get(cachePath);
}

// ─── Policy ───────────────────────────────────────────────────────────────────

const isNonEmptyArray = (data: unknown): boolean => Array.isArray(data) && data.length > 0;

/** Decide whether a fetch is warranted (no lock taken, no I/O beyond local stat/read). */
export function planModelSync(options: ModelSyncOptions): SyncPlan {
  const { cachePath, apiKey, force = false } = options;
  if (!apiKey) return { fetch: false, reason: "no-key" };

  const now = options.now ?? Date.now();
  const ttlMs = resolveSyncTtlMs(options.ttlMs);
  const fingerprint = keyFingerprint(apiKey);
  const meta = readMeta(cachePath);
  const cacheMtime = mtimeMs(cachePath);
  const valid = cacheMtime !== null && (options.isValidCache ?? isNonEmptyArray)(readJson(cachePath));

  let reason: SyncReason;
  if (!valid) reason = "missing";
  // A cache without a sidecar (older extension version) counts as an unknown key.
  else if (meta?.keyFingerprint !== fingerprint) reason = "key-changed";
  else if (force) reason = "forced";
  else if (now - cacheMtime < ttlMs) return { fetch: false, reason: "fresh" };
  else reason = "stale";

  if (!force && meta?.failedKeyFingerprint === fingerprint && typeof meta.failedAt === "number"
      && now - meta.failedAt < Math.min(FAILURE_BACKOFF_MS, ttlMs)) {
    return { fetch: false, reason: "backoff" };
  }
  return { fetch: true, reason };
}

/** Atomically create the lock file; reclaim it once if its holder looks dead. */
function tryLock(lockPath: string, token: string, lockStaleMs: number, now: number): "locked" | "held" | "unwritable" {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    return "unwritable";
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      // EEXIST: someone holds the lock. Anything else (EACCES, ENOTDIR, EROFS…):
      // the cache dir is unusable — fail open to "skip the fetch".
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return "unwritable";
      if (attempt > 0) return "held";
      const lockMtime = mtimeMs(lockPath);
      if (lockMtime === null) continue; // released between open and stat: retry once
      if (now - lockMtime <= lockStaleMs) return "held"; // a live process is fetching
      // Stale: the holder crashed or hung. Reclaim and retry once. (Two processes
      // reclaiming the same stale lock at the same instant may both fetch — a rare,
      // harmless duplicate.)
      try { fs.unlinkSync(lockPath); } catch { /* someone else reclaimed it first */ }
      continue;
    }
    // We own the lock. Record a token so release() only deletes our own lock.
    let wrote = false;
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: now }));
      wrote = true;
    } catch {
      // e.g. ENOSPC — handled below
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    if (wrote) return "locked";
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    return "unwritable";
  }
  return "held";
}

/**
 * Decide and, when this process should fetch, take the cross-process lock.
 * Returns null when the caller must skip the network (serve cache/embedded).
 * Never throws.
 */
export function acquireModelSync(options: ModelSyncOptions): ModelSyncLease | null {
  try {
    const plan = planModelSync(options);
    if (!plan.fetch) return skip(options, plan.reason);

    const { cachePath } = options;
    const now = options.now ?? Date.now();
    const lockPath = syncLockPath(cachePath);
    const token = crypto.randomBytes(8).toString("hex");
    const lock = tryLock(lockPath, token, options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS, now);
    if (lock !== "locked") return skip(options, lock === "held" ? "locked" : "unwritable");

    const fingerprint = keyFingerprint(options.apiKey as string);
    let released = false;
    return {
      reason: plan.reason,
      release(outcome: SyncOutcome): void {
        if (released) return;
        released = true;
        try {
          const at = Date.now();
          if (outcome === "fetched") {
            writeMeta(cachePath, { version: 1, keyFingerprint: fingerprint, fetchedAt: at });
            markCacheLoaded(cachePath); // our own write is not "another process's" update
          } else if (outcome === "failed") {
            const previous = readMeta(cachePath);
            writeMeta(cachePath, { ...previous, version: 1, failedAt: at, failedKeyFingerprint: fingerprint });
          }
          // Only remove the lock if it is still ours (it may have been reclaimed as stale).
          const held = readJson(lockPath) as { token?: string } | undefined;
          if (held?.token === token) fs.unlinkSync(lockPath);
        } catch {
          // Never throw from cleanup; a leftover lock expires after lockStaleMs.
        }
      },
    };
  } catch {
    return skip(options, "unwritable");
  }
}

function skip(options: ModelSyncOptions, reason: SkipReason): null {
  try { options.onSkip?.(reason); } catch { /* diagnostics must never break startup */ }
  return null;
}
