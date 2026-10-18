/// <reference types="vitest/config" />
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    target: "chrome91",
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["es", "cjs"],
      fileName: (format) => format === "es" ? "index.js" : "index.cjs",
    },
    // Nothing is external: Leaflet, toGeoJSON and fflate are BUNDLED so
    // every consumer ships the exact audited versions and needs no
    // dependency of its own.
    rollupOptions: {
      output: {
        assetFileNames: (asset) => asset.name === "style.css" ? "style.css" : "assets/[name][extname]",
      },
    },
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.spec.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
