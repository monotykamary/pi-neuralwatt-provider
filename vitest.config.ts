import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
  resolve: {
    // Match only these entrypoints; classifier API subpaths use the real SDK.
    alias: [
      { find: /^@earendil-works\/pi-ai(?:\/compat)?$/, replacement: path.resolve(__dirname, "tests/__mocks__/pi-ai.ts") },
      { find: /^@earendil-works\/pi-coding-agent$/, replacement: path.resolve(__dirname, "tests/__mocks__/pi-coding-agent.ts") },
    ],
  },
});
