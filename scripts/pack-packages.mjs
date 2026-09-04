#!/usr/bin/env node
/**
 * Pack every publishable workspace package into tarballs.
 *
 * `pnpm pack` (not `npm pack`) is used deliberately: it is what rewrites the
 * `workspace:^` dependency ranges into real semver ranges. `npm pack` leaves
 * them verbatim and publishes a manifest no consumer can install.
 *
 * Usage: node scripts/pack-packages.mjs [outputDir]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/** Every package in the workspace, published or not. */
export function workspacePackages() {
  const dir = join(root, 'packages');
  return readdirSync(dir).map((name) => ({
    dir: join(dir, name),
    manifest: JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8')),
  }));
}

/** Every workspace package that is meant to reach the registry, in dependency order. */
export function publishablePackages() {
  return workspacePackages()
    .filter((pkg) => pkg.manifest.private !== true)
    .sort((a, b) => order(a.manifest.name) - order(b.manifest.name));
}

// Publish order matters: a consumer installing @open-nav/client the moment it
// appears must already be able to resolve the @open-nav/core it depends on.
const ORDER = [
  '@open-nav/core',
  '@open-nav/client',
  '@open-nav/invoicing',
  '@open-nav/mock-server',
  '@open-nav/cli',
  '@open-nav/mcp',
];
function order(name) {
  const index = ORDER.indexOf(name);
  if (index < 0) throw new Error(`${name} is publishable but has no place in the publish order`);
  return index;
}

export function packAll(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const tarballs = [];
  for (const pkg of publishablePackages()) {
    // --json reports the exact path, rather than us guessing at how pnpm
    // flattens a scoped name into a filename.
    const output = execFileSync('pnpm', ['pack', '--json', '--pack-destination', outDir], {
      cwd: pkg.dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const { filename } = JSON.parse(output);
    tarballs.push({ ...pkg, tarball: resolve(pkg.dir, filename) });
  }
  return tarballs;
}

if (process.argv[1] === import.meta.filename) {
  const outDir = resolve(process.argv[2] ?? join(root, 'dist-packages'));
  for (const { manifest, tarball } of packAll(outDir)) {
    console.log(`${manifest.name}@${manifest.version} -> ${tarball}`);
  }
}
