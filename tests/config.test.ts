import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// We test the config parsing by importing the module's loadConfig indirectly.
// Since loadConfig reads from the filesystem at import time and on session_start,
// we test the parseDisplayMode logic and the config file loading path directly.

const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "extensions");
const CONFIG_PATH = path.join(CONFIG_DIR, "neuralwatt.json");

// Replicate the parsing logic inline to test it without module-level side effects.
// The real code under test is in index.ts — these unit tests validate the
// parsing rules that loadConfig() applies.

type DisplayMode = "widget" | "statusbar" | "off";

const VALID_DISPLAY_MODES = new Set<string>(["widget", "statusbar", "off"]);

function parseDisplayMode(value: unknown, fallback: DisplayMode): DisplayMode {
  if (typeof value === "string" && VALID_DISPLAY_MODES.has(value)) return value as DisplayMode;
  return fallback;
}

interface NeuralwattConfig {
  energy: DisplayMode;
  quota: DisplayMode;
}

function parseConfig(raw: any): NeuralwattConfig {
  return {
    energy: parseDisplayMode(raw.energy, "widget"),
    quota: parseDisplayMode(raw.quota, "widget"),
  };
}

describe("parseDisplayMode", () => {
  it("accepts valid display modes", () => {
    expect(parseDisplayMode("widget", "off")).toBe("widget");
    expect(parseDisplayMode("statusbar", "off")).toBe("statusbar");
    expect(parseDisplayMode("off", "widget")).toBe("off");
  });

  it("falls back on invalid values", () => {
    expect(parseDisplayMode("invalid", "widget")).toBe("widget");
    expect(parseDisplayMode("invalid", "statusbar")).toBe("statusbar");
    expect(parseDisplayMode("invalid", "off")).toBe("off");
  });

  it("falls back on non-string values", () => {
    expect(parseDisplayMode(42, "widget")).toBe("widget");
    expect(parseDisplayMode(true, "widget")).toBe("widget");
    expect(parseDisplayMode(null, "widget")).toBe("widget");
    expect(parseDisplayMode(undefined, "widget")).toBe("widget");
    expect(parseDisplayMode({}, "widget")).toBe("widget");
  });

  it("falls back on empty string", () => {
    expect(parseDisplayMode("", "widget")).toBe("widget");
  });
});

describe("parseConfig", () => {
  it("returns defaults for empty object", () => {
    expect(parseConfig({})).toEqual({ energy: "widget", quota: "widget" });
  });

  it("parses valid config", () => {
    expect(parseConfig({ energy: "statusbar", quota: "off" })).toEqual({
      energy: "statusbar",
      quota: "off",
    });
  });

  it("falls back individual keys on invalid values", () => {
    expect(parseConfig({ energy: "bad", quota: "statusbar" })).toEqual({
      energy: "widget",
      quota: "statusbar",
    });
    expect(parseConfig({ energy: "widget", quota: 123 })).toEqual({
      energy: "widget",
      quota: "widget",
    });
  });

  it("handles the issue author's use case config", () => {
    const config = parseConfig({ energy: "widget", quota: "off" });
    expect(config.energy).toBe("widget");
    expect(config.quota).toBe("off");
  });

  it("handles both off", () => {
    expect(parseConfig({ energy: "off", quota: "off" })).toEqual({
      energy: "off",
      quota: "off",
    });
  });

  it("handles both statusbar", () => {
    expect(parseConfig({ energy: "statusbar", quota: "statusbar" })).toEqual({
      energy: "statusbar",
      quota: "statusbar",
    });
  });

  it("handles mixed display modes", () => {
    expect(parseConfig({ energy: "off", quota: "statusbar" })).toEqual({
      energy: "off",
      quota: "statusbar",
    });
    expect(parseConfig({ energy: "statusbar", quota: "widget" })).toEqual({
      energy: "statusbar",
      quota: "widget",
    });
  });
});

describe("config file loading", () => {
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns defaults when config file does not exist", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    function loadConfig(): NeuralwattConfig {
      try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        return parseConfig(raw);
      } catch {
        return { energy: "widget", quota: "widget" };
      }
    }

    expect(loadConfig()).toEqual({ energy: "widget", quota: "widget" });
  });

  it("populates the config file with defaults when it does not exist", () => {
    const writeMock = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);
    const mkdirMock = vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const defaultConfig = { energy: "widget", quota: "widget" };

    function loadConfigWithPopulate(): NeuralwattConfig {
      try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        return parseConfig(raw);
      } catch {
        try {
          fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2) + "\n");
        } catch {
          // Write failure is non-fatal
        }
        return { ...defaultConfig };
      }
    }

    const result = loadConfigWithPopulate();
    expect(result).toEqual({ energy: "widget", quota: "widget" });
    expect(mkdirMock).toHaveBeenCalledWith(path.dirname(CONFIG_PATH), { recursive: true });
    expect(writeMock).toHaveBeenCalledWith(
      CONFIG_PATH,
      JSON.stringify(defaultConfig, null, 2) + "\n",
    );
  });

  it("returns defaults even if populate write fails", () => {
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const defaultConfig = { energy: "widget", quota: "widget" };

    function loadConfigWithPopulate(): NeuralwattConfig {
      try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        return parseConfig(raw);
      } catch {
        try {
          fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2) + "\n");
        } catch {
          // Write failure is non-fatal
        }
        return { ...defaultConfig };
      }
    }

    expect(loadConfigWithPopulate()).toEqual({ energy: "widget", quota: "widget" });
  });

  it("returns defaults when config file has invalid JSON", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("not json {{{");

    function loadConfig(): NeuralwattConfig {
      try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        return parseConfig(raw);
      } catch {
        return { energy: "widget", quota: "widget" };
      }
    }

    expect(loadConfig()).toEqual({ energy: "widget", quota: "widget" });
  });

  it("loads a valid config file", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ energy: "statusbar", quota: "off" }),
    );

    function loadConfig(): NeuralwattConfig {
      try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        return parseConfig(raw);
      } catch {
        return { energy: "widget", quota: "widget" };
      }
    }

    expect(loadConfig()).toEqual({ energy: "statusbar", quota: "off" });
  });

  it("ignores unknown keys in the config file", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ energy: "off", quota: "statusbar", futureKey: true }),
    );

    function loadConfig(): NeuralwattConfig {
      try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        return parseConfig(raw);
      } catch {
        return { energy: "widget", quota: "widget" };
      }
    }

    expect(loadConfig()).toEqual({ energy: "off", quota: "statusbar" });
  });
});

describe("quota fetch gating by config", () => {
  it("should fetch quota when quota config is 'widget'", () => {
    const config = parseConfig({ energy: "widget", quota: "widget" });
    expect(config.quota !== "off").toBe(true);
  });

  it("should fetch quota when quota config is 'statusbar'", () => {
    const config = parseConfig({ energy: "widget", quota: "statusbar" });
    expect(config.quota !== "off").toBe(true);
  });

  it("should not fetch quota when quota config is 'off'", () => {
    const config = parseConfig({ energy: "widget", quota: "off" });
    expect(config.quota !== "off").toBe(false);
  });

  it("energy config does not affect quota fetch gating", () => {
    const config = parseConfig({ energy: "off", quota: "widget" });
    expect(config.quota !== "off").toBe(true);
  });
});
