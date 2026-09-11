/**
 * The Web crypto provider, on its own entry point.
 *
 * It is kept out of the package's main entry deliberately: the main entry then
 * pulls in no `@noble/*` code, so a Node, Bun or Deno consumer — whose built-in
 * `node:crypto` already covers everything the library needs — never bundles the
 * pure-JS fallback. Import it only where `node:crypto` lacks SHA-3, notably
 * Cloudflare Workers:
 *
 * ```ts
 * import { setCryptoProvider } from '@open-nav/core';
 * import { createWebCryptoProvider } from '@open-nav/core/web';
 *
 * setCryptoProvider(createWebCryptoProvider());
 * ```
 *
 * @module
 */
export { createWebCryptoProvider } from './crypto/web-provider.js';
