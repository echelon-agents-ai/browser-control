import { defineConfig } from "vitest/config";

// Only run source tests; never the compiled copies tsc emits into dist/.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], exclude: ["dist/**", "node_modules/**"] },
});
