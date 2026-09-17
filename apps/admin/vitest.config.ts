import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// HTTP-level tests start the built app with `next start` on a free port.
// `server-only` is aliased to an empty shim (Vite `resolve.alias`); no other module resolution changes.
export default defineConfig({
  resolve: {
    alias: [{ find: /^server-only$/, replacement: fileURLToPath(new URL('./test/support/server-only-shim.ts', import.meta.url)) }],
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
