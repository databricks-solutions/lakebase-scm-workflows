import { defineConfig } from "vitest/config";

// Tests in templates/** are scaffolded artifacts that ship with USER
// projects (e.g. templates/project/nodejs/tests/app.test.js requires
// supertest and a sibling src/index.js, neither exists in this repo).
// They're meant to run AFTER scaffold, not as part of our test suite.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.js"],
    exclude: ["templates/**", "node_modules/**", "dist/**"],
  },
});
