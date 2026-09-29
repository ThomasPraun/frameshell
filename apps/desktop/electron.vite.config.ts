import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  // Main: ESM (package "type": "module"); dependencies stay external and load from node_modules.
  main: {},
  preload: {
    build: {
      rollupOptions: {
        // Sandboxed preloads cannot be ES modules.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [react()],
    worker: { format: "es" },
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") },
    },
  },
});
