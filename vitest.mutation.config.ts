import { defineConfig } from 'vitest/config';

/**
 * A fast, focused test set for Stryker's mutation runs: only the suites that
 * exercise the money modules. Keeping the browser PDF and CLI suites out makes
 * the per-mutant runs quick and the initial run green everywhere.
 */
export default defineConfig({
  test: {
    include: [
      'packages/core/test/decimal.test.ts',
      'packages/core/test/decimal.property.test.ts',
      'packages/core/test/summary.test.ts',
      'packages/core/test/summary.property.test.ts',
      'packages/core/test/summary.mutants.test.ts',
    ],
  },
});
