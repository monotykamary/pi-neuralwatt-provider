import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let home: string;
let config: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "neuralwatt-settings-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
  config = path.join(home, "extensions", "neuralwatt.json");
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

async function start() {
  const { default: init } = await import("../index.js");
  let handler!: (args: string, ctx: unknown) => Promise<void>;
  init({ on: vi.fn(), registerProvider: vi.fn(), registerCommand: (_name, command) => { handler = (args, ctx) => command.handler(args, ctx as Parameters<typeof command.handler>[1]); } } as Parameters<typeof init>[0]);
  const notify = vi.fn();
  return { notify, edit: (select: (title: string, items: string[]) => string | undefined) => handler("", {
    mode: "rpc", hasUI: true, model: { provider: "other" }, ui: { select, notify, setWidget: vi.fn(), setStatus: vi.fn() },
  }) };
}

it("keeps edits made during the settings prompt", async () => {
  const { edit } = await start();
  const concurrentValue = { quota: "statusbar", unknown: ["keep"], modelOverrides: { model: { futureOverride: true } } };
  await edit((title, items) => {
    if (title !== "Energy display") return items.find((item) => item.startsWith("Energy display:"));
    fs.writeFileSync(config, JSON.stringify(concurrentValue));
    return "off";
  });
  expect(JSON.parse(fs.readFileSync(config, "utf8"))).toEqual({ ...concurrentValue, energy: "off" });
});

it("leaves malformed settings in place at startup and on an attempted UI write", async () => {
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, "{not-json");
  const { edit, notify } = await start();
  expect(fs.readFileSync(config, "utf8")).toBe("{not-json");
  await edit((title, items) => title === "Energy display" ? "off" : items.find((item) => item.startsWith("Energy display:")));
  expect(fs.readFileSync(config, "utf8")).toBe("{not-json");
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("Could not save Neuralwatt settings"), "error");
  expect(notify).toHaveBeenCalledOnce();
});
