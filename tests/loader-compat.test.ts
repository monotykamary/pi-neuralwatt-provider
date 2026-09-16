// Loader-compatibility guards for the standalone pi binaries.
//
// Pi loads extensions through jiti. When a transformed module cannot run via
// vm.runInThisContext — because it references a bare `import.meta` or an
// optional-chained `import.meta?.x` — jiti falls back to handing the module to
// the runtime as a `data:text/javascript;base64,...` URL. Bun < 1.4 rejects
// any specifier longer than MAX_PATH_BYTES * 1.5 (6144 bytes on Linux) with
// NameTooLong before it consults the data: scheme, so that module never loads
// and pi reports "Failed to load extension ... neuralwatt-mcr.ts".
//
// The standalone pi binaries still pin bun 1.3.14, so every user installed from
// pi.dev hits this while npm/bun installs do not. Plain `import.meta.url` is
// transformed by jiti and takes the in-context path instead, so the rule is:
// never reference `import.meta` without a member access.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Every module the extension loader pulls in for this package.
const LOADED_SOURCES = ["index.ts", "neuralwatt-mcr.ts", "chad-mcr-upstream.ts", "transform.ts"];

describe("extension loader compatibility", () => {
  it.each(LOADED_SOURCES)("%s avoids the jiti data: URL fallback", (file) => {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    const hazards = source.match(/import\.meta(?!\.)/g) ?? [];
    expect(hazards, `${file} must only ever use import.meta.url`).toEqual([]);
  });
});
