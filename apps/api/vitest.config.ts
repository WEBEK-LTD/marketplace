import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compiles the tests so NestJS decorator metadata is emitted (TOOL-4).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
