import { defineConfig } from "vitest/config";

// No GAPLESS_* env: tests run against the packaged deployment, exactly as a release install does.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
