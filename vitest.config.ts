import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        // cli is a thin tool layer over the libraries it wires together.
        'packages/cli/src/**',
        // Generated code (types, schema, fault/tax tables) is transcribed from
        // the XSDs, not hand-written, and would swamp the signal.
        'packages/*/src/generated/**',
        // Re-export barrels have no logic to cover.
        'packages/*/src/index.ts',
        // The in-process mocks are test-support fixtures, exercised end to end
        // by the lifecycle tests but not a coverage target themselves.
        'packages/evat/src/mock.ts',
        'packages/receipt/src/mock.ts',
      ],
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
