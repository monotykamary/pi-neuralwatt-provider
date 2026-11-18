import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type JsonObject = Record<string, unknown>;

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new Error("Settings must contain a JSON object");
  return value;
}

// Create only absent containers. Refuse to replace malformed data along the
// selected path, and don't descend through inherited keys such as __proto__.
export function settingsObjectAt(object: JsonObject, key: string): JsonObject {
  if (!Object.hasOwn(object, key)) {
    const child: JsonObject = {};
    Object.defineProperty(object, key, { value: child, enumerable: true, writable: true, configurable: true });
    return child;
  }
  const child = object[key];
  if (!isObject(child)) throw new Error(`Settings field ${key} must be a JSON object`);
  return child;
}

function readSnapshot(filename: string): { raw: JsonObject; mode: number } | undefined {
  let fd: number;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Settings path is not a regular file");
    return { raw: parseObject(fs.readFileSync(fd, "utf8")), mode: stat.mode & 0o7777 };
  } finally {
    fs.closeSync(fd);
  }
}

function resolveTarget(filename: string): string {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  try {
    // Lock and rename next to the actual target, not over a symlink to it.
    return fs.realpathSync(filename);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    try {
      fs.lstatSync(filename);
    } catch (missing) {
      if (!hasCode(missing, "ENOENT")) throw missing;
      return path.join(fs.realpathSync(path.dirname(filename)), path.basename(filename));
    }
    // A path entry exists: resolve it again, or fail on a dangling link.
    return fs.realpathSync(filename);
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function withSettingsLock<T>(filename: string, action: () => T): T {
  const lock = `${filename}.lock`;
  const deadline = performance.now() + 250;
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const remaining = deadline - performance.now();
      // Never steal based on age or PID reuse. If a process crashed, this lock
      // needs manual removal after confirming no settings writer is active.
      if (remaining <= 0) throw new Error(`Settings lock is busy: ${lock}`);
      Atomics.wait(sleeper, 0, 0, Math.min(10, remaining));
    }
  }
  try {
    return action();
  } finally {
    fs.rmdirSync(lock);
  }
}

function publish(filename: string, raw: JsonObject, mode?: number): void {
  const text = JSON.stringify(raw, null, 2) + "\n";
  const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  let moved = false;
  try {
    try {
      fs.writeFileSync(fd, text);
      if (mode !== undefined) fs.fchmodSync(fd, mode);
    } finally {
      fs.closeSync(fd);
    }
    if (mode === undefined) {
      // An initial publication must not replace a file or symlink created by
      // a non-cooperating writer after we checked. Link the complete temp with
      // atomic no-clobber semantics; rename cannot provide that in Node.
      fs.linkSync(temp, filename);
    } else {
      fs.renameSync(temp, filename);
      moved = true;
    }
  } finally {
    if (!moved) fs.unlinkSync(temp);
  }
}

// Startup is best-effort: defaults are usable in memory, but never written
// over an invalid or unreadable existing config.
export function loadSettings(filename: string, defaults: object): JsonObject {
  const fallback = parseObject(JSON.stringify(defaults));
  try {
    const existing = readSnapshot(filename);
    if (existing) return existing.raw;
    const target = resolveTarget(filename);
    return withSettingsLock(target, () => {
      const current = readSnapshot(target);
      if (current) return current.raw;
      try {
        publish(target, fallback);
      } catch (error) {
        if (hasCode(error, "EEXIST")) return readSnapshot(target)?.raw ?? fallback;
        throw error;
      }
      return fallback;
    });
  } catch {
    return fallback;
  }
}

// UI saves mutate only their own fields in the latest raw snapshot. Unlike
// startup, a bad file or a failed write is an error, not a writable default.
export function updateSettings(filename: string, defaults: object, mutate: (raw: JsonObject) => void): JsonObject {
  const target = resolveTarget(filename);
  return withSettingsLock(target, () => {
    const current = readSnapshot(target);
    if (current) fs.accessSync(target, fs.constants.W_OK);
    const raw = current?.raw ?? parseObject(JSON.stringify(defaults));
    mutate(raw);
    publish(target, raw, current?.mode);
    return raw;
  });
}
