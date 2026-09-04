import { createRequire } from 'node:module';

/**
 * The package's own version, read from its manifest rather than duplicated
 * here. A hardcoded copy is a release-day footgun: it drifts silently, and
 * the first thing a bug report quotes is `open-nav --version`.
 */
export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
