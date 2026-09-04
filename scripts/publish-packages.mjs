#!/usr/bin/env node
/**
 * Publish every workspace package to npm.
 *
 * The two-step shape — `pnpm pack`, then `npm publish <tarball>` — is
 * deliberate, because neither tool can do the whole job:
 *
 * - only `pnpm pack` rewrites `workspace:^` into a real semver range;
 * - only `npm publish` implements provenance attestation and npm's trusted
 *   publishing (OIDC), which is how a release avoids a long-lived token.
 *
 * Publishing the tarball rather than the directory gets both, and publishes
 * exactly the artifact that was validated.
 *
 * Usage: node scripts/publish-packages.mjs [--dry-run] [--tag next] [--otp 123456]
 */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { packAll } from './pack-packages.mjs';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    tag: { type: 'string' },
    otp: { type: 'string' },
    'out-dir': { type: 'string' },
  },
});

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(values['out-dir'] ?? join(root, 'dist-packages'));

const tarballs = packAll(outDir);
console.log(`Packed ${tarballs.length} packages into ${outDir}\n`);

for (const { manifest, tarball } of tarballs) {
  const args = ['publish', tarball, '--access', 'public'];
  if (values.tag) args.push('--tag', values.tag);
  if (values.otp) args.push('--otp', values.otp);
  if (values['dry-run']) args.push('--dry-run');

  console.log(`> npm ${args.filter((a) => a !== values.otp).join(' ')}`);
  // Sequential, in dependency order: a consumer who installs @open-nav/client
  // the second it appears must already be able to resolve @open-nav/core.
  execFileSync('npm', args, { stdio: 'inherit', cwd: root });
  const what = values['dry-run'] ? 'would publish' : 'published';
  console.log(`${what} ${manifest.name}@${manifest.version}\n`);
}

console.log(values['dry-run'] ? 'Dry run complete; nothing was published.' : 'Done.');
