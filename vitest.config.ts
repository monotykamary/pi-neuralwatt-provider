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
    alias: {
      // index.ts imports streamOpenAICompletions from the `/compat` subpath;
      // the exact-match `@earendil-works/pi-ai` alias below doesn't cover it,
      // so without this entry every test that imports ../index fails to load.
      "@earendil-works/pi-ai/compat": path.resolve(__dirname, "tests/__mocks__/pi-ai.ts"),
      "@earendil-works/pi-ai": path.resolve(__dirname, "tests/__mocks__/pi-ai.ts"),
      "@earendil-works/pi-coding-agent": path.resolve(__dirname, "tests/__mocks__/pi-coding-agent.ts"),
    },
  },
});
