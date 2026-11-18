import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, settingsObjectAt, updateSettings } from "../settings-file.js";

const defaults = { feature: { enabled: false } };
let dir: string;
let config: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-settings-")));
  config = path.join(dir, "settings.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function read(filename = config): unknown {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

describe("settings file transactions", () => {
  it("publishes complete first-run defaults without overwriting a racing creator", () => {
    const link = fs.linkSync;
    const rival = { handEdited: true };
    vi.spyOn(fs, "linkSync").mockImplementationOnce((source, target) => {
      expect(path.dirname(String(source))).toBe(dir);
      expect(read(String(source))).toEqual(defaults);
      expect(fs.existsSync(config)).toBe(false);
      fs.writeFileSync(config, JSON.stringify(rival), { flag: "wx" });
      return link(source, target);
    });
    expect(loadSettings(config, defaults)).toEqual(rival);
    expect(read()).toEqual(rival);
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });

  it.each(["{ invalid", "[]", "null"])("never overwrites invalid authoritative data: %s", (text) => {
    fs.writeFileSync(config, text);
    expect(loadSettings(config, defaults)).toEqual(defaults);
    const edit = vi.fn();
    expect(() => updateSettings(config, defaults, edit)).toThrow();
    expect(edit).not.toHaveBeenCalled();
    expect(fs.readFileSync(config, "utf8")).toBe(text);
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });

  it.skipIf(process.platform === "win32")("updates the actual target atomically while retaining a symlink and its target mode", () => {
    const target = path.join(dir, "target.json");
    fs.writeFileSync(target, JSON.stringify({ feature: { enabled: false }, unrelated: true }));
    fs.chmodSync(target, 0o640);
    fs.symlinkSync("target.json", config);
    const rename = fs.renameSync;
    let sawRename = false;
    vi.spyOn(fs, "renameSync").mockImplementationOnce((source, destination) => {
      expect(path.dirname(String(source))).toBe(dir);
      expect(destination).toBe(target);
      expect(read()).toEqual({ feature: { enabled: false }, unrelated: true });
      expect(read(String(source))).toEqual({ feature: { enabled: true }, unrelated: true });
      sawRename = true;
      return rename(source, destination);
    });
    updateSettings(config, defaults, (raw) => { settingsObjectAt(raw, "feature").enabled = true; });
    expect(sawRename).toBe(true);
    expect(fs.readlinkSync(config)).toBe("target.json");
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(read()).toEqual({ feature: { enabled: true }, unrelated: true });
    expect(fs.readdirSync(dir).sort()).toEqual(["settings.json", "target.json"]);
  });

  it("leaves original bytes and someone else's temp intact on failed rename", () => {
    const original = "{\"unrelated\": true}";
    const othersTemp = path.join(dir, ".settings.json.other.tmp");
    fs.writeFileSync(config, original);
    fs.writeFileSync(othersTemp, "someone else's temp");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("rename failed"); });
    expect(() => updateSettings(config, defaults, (raw) => { raw.added = true; })).toThrow("rename failed");
    expect(fs.readFileSync(config, "utf8")).toBe(original);
    expect(fs.readFileSync(othersTemp, "utf8")).toBe("someone else's temp");
    expect(fs.readdirSync(dir).sort()).toEqual([".settings.json.other.tmp", "settings.json"]);
  });

  it("serializes processes and never steals even an old lock from a live writer", () => {
    fs.writeFileSync(config, JSON.stringify({ unrelated: true }));
    const helper = new URL("../settings-file.ts", import.meta.url).href;
    const attempt = () => spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { updateSettings } from ${JSON.stringify(helper)};
      try {
        updateSettings(${JSON.stringify(config)}, {}, (raw) => {
          console.log("read", JSON.stringify(raw));
          raw.otherProcess = true;
        });
      } catch (error) {
        console.error(error.message);
        process.exitCode = 12;
      }
    `], { encoding: "utf8", timeout: 4000 });

    updateSettings(config, defaults, (raw) => {
      fs.utimesSync(config + ".lock", new Date(0), new Date(0));
      raw.firstWriter = true;
      const blocked = attempt();
      expect(blocked.error).toBeUndefined();
      expect(blocked.status).toBe(12);
      expect(blocked.stderr).toContain("Settings lock is busy");
      expect(blocked.stdout).not.toContain("read");
      expect(read()).toEqual({ unrelated: true });
    });
    const written = attempt();
    expect(written.error).toBeUndefined();
    expect(written.status, written.stderr).toBe(0);
    expect(written.stdout).toContain('"firstWriter":true');
    expect(read()).toEqual({ unrelated: true, firstWriter: true, otherProcess: true });
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });
});
