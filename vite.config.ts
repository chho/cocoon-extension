import { resolve } from "node:path";
import { defineConfig } from "vite";

import { createExtensionBuildPlugin } from "./scripts/build/extension-build-plugin.ts";
import { createStaticAssetsPlugin } from "./scripts/build/static-assets-plugin.ts";

const iconAssets = [16, 32, 48, 128].map((size) => ({
  sourcePath: `icons/icon-${size}.png`,
  outputPath: `icons/icon-${size}.png`,
}));

export default defineConfig({
  publicDir: false,
  plugins: [
    createStaticAssetsPlugin({
      projectRoot: import.meta.dirname,
      assets: iconAssets,
    }),
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
