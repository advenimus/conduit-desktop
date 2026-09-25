import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Build output holds compiled copies of the tests (tsc emits __tests__ too).
    exclude: [...configDefaults.exclude, "dist/**", "dist-electron/**", "release/**"],
  },
});
