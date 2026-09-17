import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC emits NestJS decorator metadata. Tests start their own throwaway redis-server processes
// (binary from REDIS_SERVER_BIN or PATH) and run one file at a time because they measure timing.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./test/support/setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
