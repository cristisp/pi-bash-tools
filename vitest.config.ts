import { defineConfig } from "vitest/config";

const sequentialTestFiles = ["test/policy/directory/security.test.ts"];

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: {
        lines: 75,
        functions: 75,
        statements: 75,
        branches: 75,
      },
    },
    projects: [
      {
        test: {
          name: "parallel",
          include: ["test/**/*.test.ts"],
          exclude: sequentialTestFiles,
        },
      },
      {
        test: {
          name: "sequential",
          include: sequentialTestFiles,
          fileParallelism: false,
        },
      },
    ],
  },
});
