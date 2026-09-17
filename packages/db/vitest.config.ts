import { defineConfig } from 'vitest/config';

// Unit tests only; no database is needed. TOOL-3 runs separately (`pnpm run tool3`).
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
