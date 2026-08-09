import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 75,
        functions: 90,
        lines: 90,
        statements: 85
      }
    },
    include: ["test/**/*.spec.ts"]
  }
});
