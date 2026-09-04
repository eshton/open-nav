import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, type InvoiceData } from '@open-nav/core';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIR = join(REPO_ROOT, 'conformance', 'data-samples');

export function sample(name: string): InvoiceData {
  return structuredClone(parseDocument(readFileSync(join(DIR, name), 'utf8')).value as InvoiceData);
}

export function allSamples(): Array<{ name: string; document: InvoiceData }> {
  return readdirSync(DIR)
    .filter((name) => name.endsWith('.xml'))
    .sort()
    .map((name) => ({ name, document: sample(name) }));
}
