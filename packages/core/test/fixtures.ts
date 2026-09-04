import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root, so tests can reach `conformance/` and `schemas/`. */
export const REPO_ROOT = join(here, '..', '..', '..');

export function conformanceDir(kind: 'api-samples' | 'data-samples'): string {
  return join(REPO_ROOT, 'conformance', kind);
}

export interface Fixture {
  /** Normalised file name, e.g. `manageinvoice.xml`. */
  name: string;
  path: string;
  xml: string;
}

export function loadFixtures(kind: 'api-samples' | 'data-samples'): Fixture[] {
  const dir = conformanceDir(kind);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.xml'))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return { name, path, xml: readFileSync(path, 'utf8') };
    });
}
