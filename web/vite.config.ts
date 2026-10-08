import { defineConfig } from "vite";

// `base` is "/<repo>/" on GitHub Pages (set VITE_BASE in CI); "/" locally.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  worker: { format: "es" },
  optimizeDeps: { exclude: ["mupdf"] },
  build: { target: "es2022" },
});
