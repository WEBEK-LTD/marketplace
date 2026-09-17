import { defineConfig } from 'vitest/config';

// TOOL-4 negative control: the same DI test compiled WITHOUT SWC.
// Decorators are still compiled (legacy mode) but no decorator metadata is emitted,
// so the only difference from the real run is the missing design:paramtypes metadata.
// This run is expected to FAIL.
export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: false } },
  test: {
    include: ['test/tool4-di.test.ts'],
    environment: 'node',
  },
});
