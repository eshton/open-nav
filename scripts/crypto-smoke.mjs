// Runtime smoke test for the Web crypto provider.
//
// The provider abstraction exists so the library runs where node:crypto lacks
// SHA-3 — Cloudflare Workers above all. This script installs the Web provider
// (noble + WebCrypto) and checks the primitives against fixed vectors. It uses
// only cross-runtime APIs, so the same file runs under Node, Bun, Deno and
// workerd, proving the claim rather than asserting it.

import {
  setCryptoProvider,
  getCryptoProvider,
  nodeCryptoProvider,
  sha512,
  sha3_512,
  passwordHash,
  decodeExchangeToken,
  createRequestId,
  assertRequestId,
} from '../packages/core/dist/index.js';
import { createWebCryptoProvider } from '../packages/core/dist/web.js';

const failures = [];
const check = (name, actual, expected) => {
  if (actual !== expected) failures.push(`${name}: expected ${expected}, got ${actual}`);
};

// The default must stay the Node provider even where we are about to swap it.
check('default provider is node', getCryptoProvider() === nodeCryptoProvider, true);

setCryptoProvider(createWebCryptoProvider());

// Published NIST/FIPS vectors for "abc".
check(
  'sha512(abc)',
  sha512('abc'),
  'DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A' +
    '2192992A274FC1A836BA3C23A3FEEBBD454D4423643CE80E2A9AC94FA54CA49F',
);
check(
  'sha3_512(abc)',
  sha3_512('abc'),
  'B751850B1A57168A5693CD924B6B096E08F621827444F70D884F5D0240D2712E' +
    '10E116E9192AF3C91A7EC57647E3934057340B4CF408D5A56592F8274EEC53F0',
);
check('passwordHash matches sha512', passwordHash('abc'), sha512('abc'));

// AES-128-ECB decrypt of a token this repo encrypted with node:crypto.
check(
  'decodeExchangeToken',
  decodeExchangeToken('YlARunu0jNkLN7rPUHP6pw==', '0123456789abcdef'),
  'TOKEN0123456789A',
);

// crypto.getRandomValues drives request ids; they must satisfy NAV's schema.
try {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    const id = createRequestId();
    assertRequestId(id);
    ids.add(id);
  }
  check('request ids are unique', ids.size, 200);
} catch (error) {
  failures.push(`request id generation threw: ${error?.message ?? error}`);
}

const runtime =
  typeof navigator !== 'undefined' && navigator.userAgent
    ? navigator.userAgent
    : typeof Bun !== 'undefined'
      ? `Bun ${Bun.version}`
      : typeof Deno !== 'undefined'
        ? `Deno ${Deno.version.deno}`
        : typeof process !== 'undefined'
          ? `Node ${process.version}`
          : 'unknown runtime';

if (failures.length > 0) {
  console.error(`crypto smoke FAILED on ${runtime}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  throw new Error(`${failures.length} crypto smoke check(s) failed`);
}

console.log(`crypto smoke passed on ${runtime}`);
