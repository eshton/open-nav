import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The publish-critical parts of a manifest are exactly the parts nothing else
 * exercises: a missing `publishConfig.access` fails the release rather than a
 * test, and a wrong `repository` silently costs the provenance attestation.
 * So they are asserted here, and a new package cannot be added without them.
 */
const ROOT = new URL('..', import.meta.url).pathname;
const REPOSITORY = 'https://github.com/eshton/open-nav';

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  description?: string;
  license?: string;
  type?: string;
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
  files?: string[];
  engines?: { node?: string };
  publishConfig?: { access?: string };
  repository?: { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function read(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

const root = read(join(ROOT, 'package.json'));
const packages = readdirSync(join(ROOT, 'packages')).map((dir) => ({
  dir,
  manifest: read(join(ROOT, 'packages', dir, 'package.json')),
}));
const published = packages.filter(({ manifest }) => manifest.private !== true);

describe('publishable packages', () => {
  it('are the six that are meant to be published', () => {
    expect(published.map(({ manifest }) => manifest.name).sort()).toEqual([
      '@open-nav/cli',
      '@open-nav/client',
      '@open-nav/core',
      '@open-nav/invoicing',
      '@open-nav/mcp',
      '@open-nav/mock-server',
    ]);
    // The generator is a build tool for this repository. Publishing it would
    // invite people to depend on it.
    expect(read(join(ROOT, 'packages/codegen/package.json')).private).toBe(true);
  });

  it.each(published)('$manifest.name declares what npm needs', ({ dir, manifest }) => {
    // A scoped package defaults to restricted, i.e. a 402 on a free account.
    expect(manifest.publishConfig?.access).toBe('public');
    expect(manifest.license).toBe('MIT');
    expect(manifest.description).toBeTruthy();
    expect(manifest.type).toBe('module');
    expect(manifest.engines?.node).toBe('>=20.10.0');

    // Provenance attestation is verified against the repository and directory,
    // so a wrong value here does not fail loudly — it just does not attest.
    expect(manifest.repository).toEqual({
      type: 'git',
      url: `git+${REPOSITORY}.git`,
      directory: `packages/${dir}`,
    });
    expect(manifest.homepage).toBe(`${REPOSITORY}#readme`);
    expect(manifest.bugs).toBe(`${REPOSITORY}/issues`);
  });

  it.each(published)('$manifest.name packs its licence and readme', ({ dir, manifest }) => {
    // npm only packs files inside the package directory, so the repository
    // root LICENSE and README would never reach a consumer.
    expect(manifest.files).toEqual(['dist', 'src', 'README.md', 'LICENSE']);
    expect(readFileSync(join(ROOT, 'packages', dir, 'LICENSE'), 'utf8')).toBe(
      readFileSync(join(ROOT, 'LICENSE'), 'utf8'),
    );
    expect(readFileSync(join(ROOT, 'packages', dir, 'README.md'), 'utf8')).toContain(manifest.name);
  });

  it.each(published)('$manifest.name resolves to files that exist', ({ dir, manifest }) => {
    const entry = (manifest.exports?.['.'] ?? {}) as Record<string, string>;
    expect(entry.types).toBe(manifest.types);
    expect(entry.import).toBe(manifest.main);
    // package.json is exported so tooling — and our own version lookup — can
    // read it through the package name.
    expect(manifest.exports?.['./package.json']).toBe('./package.json');

    for (const target of [manifest.main, manifest.types, ...Object.values(manifest.bin ?? {})]) {
      const source = target!.replace(/^\.\/dist\//, 'src/').replace(/\.(d\.ts|js)$/, '.ts');
      expect(
        readdirSync(join(ROOT, 'packages', dir, 'src'), { recursive: true }),
        `${manifest.name}: ${target} has no source at ${source}`,
      ).toContain(source.slice('src/'.length));
    }
  });

  it('are all at the same version as the workspace root', () => {
    // Lockstep is what lets `workspace:^` carry no version in the repository.
    for (const { manifest } of packages) {
      expect(manifest.version, manifest.name).toBe(root.version);
    }
  });

  it('depend on each other only through the workspace protocol', () => {
    for (const { manifest } of packages) {
      for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        if (!name.startsWith('@open-nav/')) continue;
        // pnpm pack rewrites this into a real range; a literal version here
        // would silently drift from what was published.
        expect(range, `${manifest.name} -> ${name}`).toBe('workspace:^');
      }
    }
  });
});
