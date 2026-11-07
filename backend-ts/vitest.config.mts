import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC keeps the decorator metadata that NestJS needs while testing.
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: { include: ["test/**/*.test.ts"], globals: false, testTimeout: 30000, pool: "forks" },
});
