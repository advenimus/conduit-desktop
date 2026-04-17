import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/electron/**", "**/dist-electron/**", "**/.worktrees/**"],
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
