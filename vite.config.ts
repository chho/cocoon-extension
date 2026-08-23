import { resolve } from "node:path";
import { defineConfig } from "vite";

import { createExtensionBuildPlugin } from "./scripts/build/extension-build-plugin.ts";

export default defineConfig({
  publicDir: false,
  plugins: [
    createExtensionBuildPlugin({ projectRoot: import.meta.dirname }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, "popup/popup.html"),
        options: resolve(import.meta.dirname, "options/options.html"),
        content: resolve(import.meta.dirname, "src/content/main.ts"),
        background: resolve(import.meta.dirname, "src/background/main.ts"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
