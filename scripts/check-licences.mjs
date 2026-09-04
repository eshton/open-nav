#!/usr/bin/env node
/**
 * Every published package carries its own copy of the licence, because npm
 * only packs files inside the package directory — the repository root LICENSE
 * would not reach a consumer. Copies drift, so this asserts they have not.
 *
 * Usage: node scripts/check-licences.mjs [--fix]
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { publishablePackages } from './pack-packages.mjs';

const root = resolve(import.meta.dirname, '..');
const canonical = join(root, 'LICENSE');
const expected = readFileSync(canonical, 'utf8');
const fix = process.argv.includes('--fix');

let wrong = 0;
for (const pkg of publishablePackages()) {
  const file = join(pkg.dir, 'LICENSE');
  let actual;
  try {
    actual = readFileSync(file, 'utf8');
  } catch {
    actual = undefined;
  }
  if (actual === expected) continue;

  if (fix) {
    copyFileSync(canonical, file);
    console.log(`updated ${relative(root, file)}`);
    continue;
  }
  wrong += 1;
  console.error(
    `${relative(root, file)} ${actual === undefined ? 'is missing' : 'differs from the root LICENSE'}` +
      ' — run `pnpm licences:fix`',
  );
}

process.exit(wrong === 0 ? 0 : 1);
