/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Vite only runs the unit tests (and, through demo/vite.config.ts, the
// demo build).  The package itself is emitted by ``tsc``: its runtime
// libraries are pinned dependencies that the host's bundler resolves.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.spec.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
