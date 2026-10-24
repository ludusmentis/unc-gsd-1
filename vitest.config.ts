import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
