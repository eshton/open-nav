#!/usr/bin/env node
/**
 * Validate the tarballs that would actually be published.
 *
 * Checking the source tree is not the same thing: `files`, the export map and
 * the `workspace:^` rewriting only take effect at pack time, so every mistake
 * worth catching here is invisible before packing.
 *
 * - `publint` checks the manifest against how Node and bundlers resolve it.
 * - `attw` (are-the-types-wrong) checks that the types resolve under each
 *   module resolution mode a consumer might be using.
 *
 * Usage: node scripts/check-packages.mjs [--skip-attw]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { packAll } from './pack-packages.mjs';

const skipAttw = process.argv.includes('--skip-attw');
const outDir = mkdtempSync(join(tmpdir(), 'open-nav-pack-'));

let failures = 0;
try {
  const tarballs = packAll(outDir);

  for (const { manifest, tarball } of tarballs) {
    const size = (statSync(tarball).size / 1024).toFixed(0);
    console.log(`\n=== ${manifest.name}@${manifest.version}  (${basename(tarball)}, ${size} KiB)`);
    failures += run('publint', [tarball]);
    // These packages are ESM-only on purpose, so `cjs-resolves-to-esm` would
    // only report that choice back at us on every run. Ignoring it is what
    // makes a genuine types problem stand out.
    if (!skipAttw) {
      failures += run('attw', [
        '--profile',
        'node16',
        '--ignore-rules',
        'cjs-resolves-to-esm',
        '--format',
        'table-flipped',
        tarball,
      ]);
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} package check(s) failed.`);
  process.exit(1);
}
console.log('\nAll packages pass publint' + (skipAttw ? '.' : ' and attw.'));

function run(tool, args) {
  try {
    execFileSync(join('node_modules', '.bin', tool), args, { stdio: 'inherit' });
    return 0;
  } catch {
    return 1;
  }
}
