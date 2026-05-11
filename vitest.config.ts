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
      "@earendil-works/pi-ai": path.resolve(__dirname, "tests/__mocks__/pi-ai.ts"),
      "@earendil-works/pi-coding-agent": path.resolve(__dirname, "tests/__mocks__/pi-coding-agent.ts"),
    },
  },
});
