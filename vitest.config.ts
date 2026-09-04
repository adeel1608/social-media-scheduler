import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/worker/test/**/*.test.ts",
      "apps/web/test/**/*.test.{ts,tsx}",
    ],
    coverage: {
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts", "apps/worker/src/**/*.ts"],
    },
  },
});
