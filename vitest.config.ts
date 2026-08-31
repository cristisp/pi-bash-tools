import { defineConfig } from "vitest/config";

const sequentialTestFiles = ["test/policy/directory/security.test.ts"];

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
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
