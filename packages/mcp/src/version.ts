import { createRequire } from 'node:module';

/** The package's own version, read from its manifest rather than duplicated. */
export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
