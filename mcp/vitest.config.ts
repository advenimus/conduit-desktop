import { configDefaults, defineConfig } from 'vitest/config';

// Used by `cd mcp && npx vitest run`: plain Node, without the root config's renderer setup file.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'dist/**'],
  },
});
