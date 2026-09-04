#!/usr/bin/env node
/**
 * Set one version across the whole workspace.
 *
 * The packages are released in lockstep, which is a deliberate simplification:
 * they depend on each other with `workspace:^`, which carries no version at
 * all in the repository, so a lockstep bump needs no dependency rewriting and
 * cannot leave a package pointing at a sibling version that was never
 * published. The cost is version numbers that move without content changes,
 * which for six packages published together is the cheaper mistake.
 *
 * Usage: node scripts/set-version.mjs 0.2.0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { workspacePackages } from './pack-packages.mjs';

const root = resolve(import.meta.dirname, '..');
const target = process.argv[2];

// Plain semver, optionally with a prerelease and build suffix.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
if (!target || !SEMVER.test(target)) {
  console.error('Usage: node scripts/set-version.mjs <semver>   e.g. 0.2.0 or 0.2.0-rc.1');
  process.exit(2);
}

// Every package, private ones included: a workspace where one manifest sits
// at a different version is a puzzle for the next reader, and the private
// packages cost nothing to keep in step.
const manifests = [
  { file: join(root, 'package.json') },
  ...workspacePackages().map((pkg) => ({ file: join(pkg.dir, 'package.json') })),
];

// Refuse to start from a workspace that has already drifted: a bump is not the
// place to discover that two packages were at different versions.
const before = new Set(manifests.map(({ file }) => JSON.parse(readFileSync(file, 'utf8')).version));
if (before.size !== 1) {
  console.error(`Versions are not in lockstep: ${[...before].sort().join(', ')}`);
  console.error('Bring them into agreement first; this script will not guess which is right.');
  process.exit(1);
}
const [current] = before;

for (const { file } of manifests) {
  const text = readFileSync(file, 'utf8');
  const manifest = JSON.parse(text);
  manifest.version = target;
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${relative(root, file)}: ${current} -> ${target}`);
}

console.log('');
console.log('Nothing else needs editing: the CLI and MCP server read their own');
console.log('manifests at runtime, and workspace dependencies carry no version.');
