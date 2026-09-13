import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // cli is a thin tool layer; evat currently holds only generated eVAT
      // types + metadata with no consumers yet (its client/validator arrive in
      // later EVAT tickets — narrow this then).
      exclude: ['packages/cli/src/**', 'packages/evat/src/**', 'packages/receipt/src/**'],
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
