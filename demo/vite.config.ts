import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "./",
  publicDir: resolve(import.meta.dirname, "../test/fixtures"),
  build: { target: "chrome91", outDir: "../demo-dist", emptyOutDir: true },
});
