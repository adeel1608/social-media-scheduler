import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["supabase/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
  },
});
