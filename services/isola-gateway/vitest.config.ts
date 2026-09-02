import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every test builds its own gateway from an explicit config object; nothing
    // may leak between test files via process.env.
    isolate: true,
  },
});
