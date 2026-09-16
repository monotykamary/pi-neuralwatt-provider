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
  // Pi loads extensions through jiti. A module that cannot run via
  // vm.runInThisContext — bare `import.meta` or `import.meta?.x` — is handed
  // to the runtime as a `data:text/javascript;base64,...` URL instead. Bun
  // < 1.4 rejects any specifier longer than MAX_PATH_BYTES * 1.5 (6144 bytes
  // on Linux) with NameTooLong before it looks at the data: scheme, so that
  // module never loads on the standalone pi binaries (which pin bun 1.3.14).
  // Plain `import.meta.url` is transformed by jiti and avoids the fallback.
  [
    'return typeof import.meta?.url === "string" ? import.meta.url : "unknown";',
    'return typeof import.meta.url === "string" ? import.meta.url : "unknown";',
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
