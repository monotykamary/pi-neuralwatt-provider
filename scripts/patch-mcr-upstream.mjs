import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../chad-mcr-upstream.ts", import.meta.url);
let source = await readFile(path, "utf8");

const replacements = [
  [
    'import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";',
    'import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";',
  ],
  [
    "models: NEURALWATT_MODELS.map((m) => ({ ...m, compat: NEURALWATT_COMPAT })),",
    "models: NEURALWATT_MODELS.map((m) => ({ ...m, input: [...m.input], compat: NEURALWATT_COMPAT })),",
  ],
  [
    "const msg = event.message as Record<string, unknown>;",
    "const msg = event.message as unknown as Record<string, unknown>;",
  ],
  [
    "event.messages as Array<{ type: string }>,",
    "event.messages as unknown as Array<{ type: string }>,",
  ],
];

for (const [before, after] of replacements) {
  if (source.includes(after)) continue;
  if (!source.includes(before)) {
    throw new Error(`Unable to apply MCR compatibility patch: ${before}`);
  }
  source = source.replace(before, after);
}

await writeFile(path, source);
