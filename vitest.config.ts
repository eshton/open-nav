import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/cli/src/**'],
      reporter: ['text', 'json-summary'],
      // Floors set a few points below the measured levels (lines/statements
      // ~85%, functions ~87%, branches ~84%), so a real regression fails the
      // build without the gate flapping on small, honest changes.
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 78,
      },
    },
  },
});
