import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 75,
        functions: 75,
        statements: 75,
        branches: 75,
      },
    },
  },
});
