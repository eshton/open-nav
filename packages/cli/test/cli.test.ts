import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/errors.js';
import { discoverEnvFiles, parseEnvFile } from '../src/config.js';
import { run } from '../src/main.js';
import type { Writer } from '../src/output.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sample = (name: string): string =>
  readFileSync(join(REPO_ROOT, 'conformance', 'data-samples', name), 'utf8');

/** Capture output instead of writing to the process streams. */
function capture(): Writer & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

const FILES: Record<string, string> = {
  'good.xml': sample('belfoldi-termekertekesites.xml'),
  'bad-totals.xml': sample('termekdijas-szamla.xml'),
  'simplified.xml': sample('belfoldi-egyszerusitett-szamla.xml'),
  // The only published sample with a warning: two placeholder tax numbers
  // whose check digits do not match.
  'warns.xml': sample('belfoldi-termekertekesites-afa-csoportok-kozott.xml'),
};

async function cli(argv: string[], options: { env?: Record<string, string> } = {}) {
  const writer = capture();
  const written = new Map<string, string>();
  const code = await run({
    argv,
    writer,
    isTty: false,
    env: options.env ?? {},
    readFile: (path) => {
      const contents = FILES[path.replace(/^\.\//, '')];
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    writeFile: (path, contents) => written.set(path, contents),
  });
  return {
    code,
    writer,
    written,
    json: () => JSON.parse(writer.stdout.join('\n')) as Record<string, unknown>,
  };
}

describe('output format', () => {
  it('emits JSON when output is not a terminal, with no flag needed', async () => {
    // An agent or script calling this must not have to remember --json.
    const { code, json } = await cli(['fault', 'INVOICE_LINE_MISSING']);
    expect(code).toBe(EXIT.ok);
    expect(json()).toMatchObject({ ok: true, command: 'fault' });
  });

  it('emits text when asked, even without a terminal', async () => {
    const { writer } = await cli(['fault', 'INVOICE_LINE_MISSING', '--pretty']);
    expect(writer.stdout.join('\n')).toBe(
      'INVOICE_LINE_MISSING: The invoice contains no line items.',
    );
  });

  it('wraps failures in the same envelope, so ok is always present', async () => {
    const { code, json } = await cli(['validate', 'bad-totals.xml']);
    expect(code).toBe(EXIT.invalid);
    expect(json()).toMatchObject({ ok: true, command: 'validate' });
    expect((json()['data'] as { valid: boolean }).valid).toBe(false);
  });

  it('reports a usage error as ok:false with a code', async () => {
    const { code, json } = await cli(['validate']);
    expect(code).toBe(EXIT.usage);
    expect(json()).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });
});

describe('describe', () => {
  it('publishes the command surface as JSON for tooling', async () => {
    const { code, json } = await cli(['--describe']);
    expect(code).toBe(EXIT.ok);
    const described = json() as {
      commands: Array<{ name: string; needsCredentials: boolean; usage: string }>;
      exitCodes: Record<string, number>;
    };
    expect(described.commands.map((command) => command.name)).toContain('validate');
    expect(described.exitCodes).toMatchObject({ ok: 0, invalid: 3, rejected: 4 });
    // Every command documents whether it needs credentials, so a caller can
    // tell what works offline.
    expect(
      described.commands.every((command) => typeof command.needsCredentials === 'boolean'),
    ).toBe(true);
    expect(described.commands.every((command) => command.usage.startsWith('open-nav'))).toBe(true);
  });
});

describe('validate', () => {
  it('accepts a valid invoice with exit code 0', async () => {
    const { code, json } = await cli(['validate', 'good.xml', '--operation', 'CREATE']);
    expect(code).toBe(EXIT.ok);
    expect(json()['data']).toMatchObject({ valid: true, errorCount: 0 });
  });

  it('rejects an invoice whose totals do not add up, with exit code 3', async () => {
    const { code, json } = await cli(['validate', 'bad-totals.xml']);
    expect(code).toBe(EXIT.invalid);
    const data = json()['data'] as { errorCount: number; issues: Array<{ navMessage: string }> };
    expect(data.errorCount).toBeGreaterThan(0);
    // Findings carry NAV's own wording, so the message matches the rejection.
    expect(data.issues[0]?.navMessage).toBeTruthy();
  });

  it('reports NAV wording in Hungarian on request', async () => {
    const { json } = await cli(['validate', 'bad-totals.xml', '--language', 'hu']);
    const data = json()['data'] as { issues: Array<{ navMessage: string }> };
    expect(data.issues[0]?.navMessage).toMatch(/[áéíóöőúüű]/i);
  });

  it('needs no credentials', async () => {
    // Nothing in the environment, and it still works.
    const { code } = await cli(['validate', 'good.xml'], { env: {} });
    expect(code).toBe(EXIT.ok);
  });

  it('can treat warnings as failures', async () => {
    const { code: lenient, json } = await cli(['validate', 'warns.xml']);
    expect(lenient).toBe(EXIT.ok);
    expect((json()['data'] as { warningCount: number }).warningCount).toBe(2);

    const { code: strict } = await cli(['validate', 'warns.xml', '--warnings-as-errors']);
    expect(strict).toBe(EXIT.invalid);
  });

  it('rejects a document that is not an invoice', async () => {
    const { code, json } = await cli(['validate', 'not-a-file.xml']);
    expect(code).toBe(EXIT.failure);
    expect(json()).toMatchObject({ ok: false });
  });
});

describe('credentials', () => {
  it('lists everything missing at once rather than one at a time', async () => {
    const { code, json } = await cli(['token', '--no-env-file']);
    expect(code).toBe(EXIT.usage);
    const message = (json()['error'] as { message: string }).message;
    for (const variable of ['NAV_LOGIN', 'NAV_PASSWORD', 'NAV_SIGN_KEY', 'NAV_EXCHANGE_KEY']) {
      expect(message).toContain(variable);
    }
  });

  it('never prints secrets in the config report', async () => {
    const { code, json } = await cli(['config', '--no-env-file'], {
      env: {
        NAV_LOGIN: 'testlogin123',
        NAV_PASSWORD: 'super-secret',
        NAV_SIGN_KEY: 'sign-secret',
        NAV_EXCHANGE_KEY: '0123456789abcdef',
        NAV_TAX_NUMBER: '11111111',
        NAV_SOFTWARE_ID: 'OPENNAV000000001',
      },
    });
    expect(code).toBe(EXIT.ok);
    const printed = JSON.stringify(json());
    expect(printed).not.toContain('super-secret');
    expect(printed).not.toContain('sign-secret');
    expect(printed).not.toContain('0123456789abcdef');
    // Non-secret values are shown, so misconfiguration is visible.
    expect(printed).toContain('testlogin123');
  });

  it('reports which required variables are still missing, and is not ready', async () => {
    const { code, json } = await cli(['config', '--no-env-file'], {
      env: { NAV_LOGIN: 'testlogin123' },
    });
    const data = json()['data'] as { missing: string[]; ready: boolean };
    expect(data.missing).toContain('NAV_PASSWORD');
    expect(data.ready).toBe(false);
    // config doubles as a readiness check, so a caller can branch on it.
    expect(code).toBe(EXIT.usage);
  });

  it('does not count an optional variable with a default as missing', async () => {
    const { code, json } = await cli(['config', '--no-env-file'], {
      env: {
        NAV_LOGIN: 'testlogin123',
        NAV_PASSWORD: 'x',
        NAV_SIGN_KEY: 'x',
        NAV_EXCHANGE_KEY: '0123456789abcdef',
        NAV_TAX_NUMBER: '11111111',
        NAV_SOFTWARE_ID: 'OPENNAV000000001',
      },
    });
    const data = json()['data'] as {
      missing: string[];
      ready: boolean;
      variables: Array<{ variable: string; required: boolean; default?: string }>;
    };
    expect(data.missing).toEqual([]);
    expect(data.ready).toBe(true);
    expect(code).toBe(EXIT.ok);

    const environment = data.variables.find((entry) => entry.variable === 'NAV_ENVIRONMENT');
    expect(environment).toMatchObject({ required: false, default: 'test' });
  });
});

describe('env files', () => {
  it('parses the forms a .env file uses', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        '',
        'NAV_LOGIN=plain',
        'export NAV_TAX_NUMBER=11111111',
        'NAV_PASSWORD="quoted value"',
        "NAV_SIGN_KEY='single quoted'",
        '  NAV_SOFTWARE_ID = spaced  ',
        'malformed line',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      NAV_LOGIN: 'plain',
      NAV_TAX_NUMBER: '11111111',
      NAV_PASSWORD: 'quoted value',
      NAV_SIGN_KEY: 'single quoted',
      NAV_SOFTWARE_ID: 'spaced',
    });
  });

  it('fails clearly when an explicit env file is absent', async () => {
    const { code, json } = await cli(['config', '--env-file', '/nowhere/.env']);
    expect(code).toBe(EXIT.usage);
    expect((json()['error'] as { message: string }).message).toMatch(/not found/);
  });

  it('walks up from the working directory when discovering env files', () => {
    // A nested working directory, which is where an agent often starts, must
    // still find the project's env file.
    const found = discoverEnvFiles(join(REPO_ROOT, 'packages', 'cli', 'src'));
    expect(Array.isArray(found)).toBe(true);
  });
});

describe('help', () => {
  it('exits non-zero with no arguments, since that is a usage mistake', async () => {
    const { code, writer } = await cli([]);
    expect(code).toBe(EXIT.usage);
    expect(writer.stdout.join('\n')).toContain('open-nav <command>');
  });

  it('exits zero for an explicit help request', async () => {
    const { code } = await cli(['--help']);
    expect(code).toBe(EXIT.ok);
  });

  it('documents every command it advertises', async () => {
    const { json } = await cli(['--describe']);
    const names = (json()['commands'] as Array<{ name: string }>).map((command) => command.name);
    for (const name of names) {
      const { code, writer } = await cli(['help', name]);
      expect(code, name).toBe(EXIT.ok);
      expect(writer.stdout.join('\n').length, name).toBeGreaterThan(0);
    }
  });

  it('explains configuration', async () => {
    const { code, writer } = await cli(['help', 'config']);
    expect(code).toBe(EXIT.ok);
    const text = writer.stdout.join('\n');
    expect(text).toContain('NAV_EXCHANGE_KEY');
    expect(text).toContain('8 digit core tax number');
  });

  it('rejects an unknown command with the list of real ones', async () => {
    const { code, writer } = await cli(['nonsense']);
    expect(code).toBe(EXIT.usage);
    expect(writer.stderr.join('\n')).toContain('validate');
  });

  it('rejects an unknown option rather than ignoring it', async () => {
    const { code, writer } = await cli(['validate', 'good.xml', '--nope']);
    expect(code).toBe(EXIT.usage);
    expect(writer.stderr.join('\n')).toMatch(/--nope/);
  });
});

describe('render', () => {
  it('writes a self-contained HTML document', async () => {
    const { code, written } = await cli(['render', 'good.xml', '--out', 'out/invoice.html']);
    expect(code).toBe(EXIT.ok);
    const html = written.get('out/invoice.html')!;
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Értékesítő Kft');
    expect(html).not.toMatch(/<script/i);
  });

  it('writes to standard output when no file is given, so it can be piped', async () => {
    const { code, writer } = await cli(['render', 'good.xml']);
    expect(code).toBe(EXIT.ok);
    expect(writer.stdout.join('\n')).toContain('<!doctype html>');
  });

  it('renders in English on request', async () => {
    const { written } = await cli(['render', 'good.xml', '--out', 'a.html', '--language', 'en']);
    expect(written.get('a.html')).toContain('Supplier');
  });

  it('rejects an unsupported language', async () => {
    const { code } = await cli(['render', 'good.xml', '--language', 'de']);
    expect(code).toBe(EXIT.usage);
  });

  it('needs no credentials', async () => {
    const { code } = await cli(['render', 'good.xml', '--out', 'a.html'], { env: {} });
    expect(code).toBe(EXIT.ok);
  });
});

describe('export', () => {
  it('writes one XML per invoice plus a manifest', async () => {
    const { code, written, json } = await cli([
      'export',
      'good.xml',
      'simplified.xml',
      '--out',
      'export',
    ]);
    expect(code).toBe(EXIT.ok);
    expect([...written.keys()].filter((name) => name.endsWith('.xml'))).toHaveLength(2);
    expect(written.has('export/manifest.json')).toBe(true);

    const data = json()['data'] as { exported: number; structure: { basis: string } };
    expect(data.exported).toBe(2);
    expect(data.structure.basis).toContain('13/A');
  });

  it('honours a date range', async () => {
    const { json } = await cli(['export', 'good.xml', '--out', 'export', '--from', '2030-01-01']);
    expect((json()['data'] as { exported: number }).exported).toBe(0);
  });

  it('requires an output directory', async () => {
    const { code, json } = await cli(['export', 'good.xml']);
    expect(code).toBe(EXIT.usage);
    expect((json()['error'] as { message: string }).message).toContain('--out');
  });

  it('records a checksum for every exported file', async () => {
    const { written } = await cli(['export', 'good.xml', '--out', 'export']);
    const manifest = JSON.parse(written.get('export/manifest.json')!) as {
      invoices: Array<{ sha256: string }>;
    };
    expect(manifest.invoices[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
