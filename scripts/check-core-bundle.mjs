// Guards the ONAV-5 invariant: the main entry of @open-nav/core pulls in no
// @noble/* code. The Web crypto provider lives at @open-nav/core/web precisely
// so a Node/Bun/Deno consumer never bundles noble; if someone re-exports it
// from the main entry again, this fails the build.
//
// It bundles the built main entry with esbuild and inspects the real module
// graph (the metafile), not string contents, so a stray comment can't fool it.

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const entry = 'packages/core/dist/index.js';

// Bundle-size budget for the main entry, gzipped. Headroom over today's size
// (~86 KiB) so ordinary growth is fine, but a heavy new dependency — or the
// @noble Web provider creeping back onto the main entry — trips it. Override
// with CORE_BUNDLE_GZIP_BUDGET_KIB when a deliberate jump is justified.
const GZIP_BUDGET_KIB = Number(process.env.CORE_BUNDLE_GZIP_BUDGET_KIB ?? 120);

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node', // node: builtins stay external; third-party deps are bundled
  write: false,
  metafile: true,
  logLevel: 'silent',
});

const modules = Object.keys(result.metafile.inputs);
const noble = modules.filter((path) => /(^|\/)@noble\/|noble-hashes|noble-ciphers/.test(path));

if (noble.length > 0) {
  console.error(`FAIL: ${entry} pulls @noble into its module graph:`);
  for (const path of noble) console.error(`  - ${path}`);
  console.error('\nThe Web provider must stay at @open-nav/core/web, off the main entry.');
  process.exit(1);
}

const output = result.outputFiles[0];
const bytes = output.contents.length;
const gzip = gzipSync(output.text).length;
const gzipKiB = gzip / 1024;

if (gzipKiB > GZIP_BUDGET_KIB) {
  console.error(
    `FAIL: ${entry} is ${gzipKiB.toFixed(1)} KiB gzip, over the ` +
      `${GZIP_BUDGET_KIB} KiB budget.\n` +
      'Check what new code entered the graph; raise CORE_BUNDLE_GZIP_BUDGET_KIB ' +
      'only for a deliberate, justified increase.',
  );
  process.exit(1);
}

console.log(
  `OK: ${entry} — ${modules.length} modules, ${(bytes / 1024).toFixed(1)} KiB ` +
    `(${gzipKiB.toFixed(1)} KiB gzip, budget ${GZIP_BUDGET_KIB} KiB), no @noble in the graph.`,
);
