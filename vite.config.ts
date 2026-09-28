import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectBootScript, loadBootScript } from "./src/lib/appearance/bootScript.mjs";

const APPEARANCE_DIR = fileURLToPath(new URL("./src/lib/appearance/", import.meta.url));

/** Replaces <!-- conduit:appearance-boot --> in every HTML shell with the pre-paint appearance script (spec 6.2). */
function conduitAppearanceBoot(): Plugin {
  return {
    name: "conduit-appearance-boot",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        return injectBootScript(html, loadBootScript(APPEARANCE_DIR), path.basename(ctx.filename));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), conduitAppearanceBoot()],
  base: './',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/electron/**",
        "**/dist-electron/**",
        "**/.worktrees/**",
        "**/freerdp-helper/**",
        "**/mcp/**",
      ],
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
  build: {
    target: ["es2022", "chrome100"],
    minify: "esbuild",
    sourcemap: process.env.NODE_ENV === "development",
    rollupOptions: {
      input: {
        main: 'index.html',
        picker: 'picker.html',
        overlay: 'overlay.html',
      },
    },
  },
});
