import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Runs the crypto tests inside workerd, the Cloudflare Workers runtime.
 *
 * workerd's node:crypto has no SHA-3, which is the reason the Web crypto
 * provider exists — so this config is what turns "should work on Workers" into
 * a test that actually does. It lives at the repo root, next to the pool it
 * imports, so the config loader resolves `@cloudflare/vitest-pool-workers/config`
 * under pnpm's layout.
 */
export default defineWorkersConfig({
  test: {
    include: ['packages/core/test-workers/**/*.test.ts'],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: '2024-12-30',
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
  },
});
