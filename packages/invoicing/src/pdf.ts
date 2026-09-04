import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvoiceData } from '@open-nav/core';
import { renderInvoiceHtml, type RenderOptions } from './html.js';

/**
 * PDF output, by way of a browser.
 *
 * A Hungarian invoice needs `ő` and `ű`, which are outside the WinAnsi
 * encoding the PDF core fonts use. Writing the PDF directly would therefore
 * mean bundling and licensing a font with the right glyphs, and subsetting it.
 * A browser already has fonts, already subsets and embeds them, and already
 * implements `@page`. So the document is rendered as HTML and converted.
 *
 * The cost is a browser on the machine. `findBrowser` locates one, `convert`
 * lets you supply your own (Playwright, Puppeteer, a print service), and the
 * error says which of those is missing.
 */

export class PdfConversionError extends Error {}

export interface PdfOptions extends RenderOptions {
  /** Browser executable. Auto-detected when omitted. */
  browserPath?: string;
  /** Extra arguments passed to the browser. */
  browserArgs?: string[];
  /**
   * Run the browser with its sandbox. On by default.
   *
   * The sandbox is what contains a malicious document, and invoice data is
   * input. It is left on even though that means conversion fails when running
   * as root — in a container or CI, pass `sandbox: false` deliberately. The
   * error message says so, rather than quietly weakening the default for
   * everybody.
   */
  sandbox?: boolean;
  /** Give up after this long. Defaults to 30 000 ms. */
  timeoutMs?: number;
  /** Environment consulted when detecting a browser. Injectable for tests. */
  env?: Record<string, string | undefined>;
  /**
   * Convert HTML to PDF yourself, instead of spawning a browser.
   *
   * ```ts
   * import { chromium } from 'playwright';
   * const convert = async (html: string) => {
   *   const browser = await chromium.launch();
   *   const page = await browser.newPage();
   *   await page.setContent(html, { waitUntil: 'load' });
   *   const pdf = await page.pdf({ printBackground: true });
   *   await browser.close();
   *   return pdf;
   * };
   * ```
   */
  convert?: (html: string) => Promise<Buffer>;
}

/** Render an invoice straight to PDF bytes. */
export async function renderInvoicePdf(
  document: InvoiceData,
  options: PdfOptions = {},
): Promise<Buffer> {
  return htmlToPdf(renderInvoiceHtml(document, options), options);
}

/** Convert a rendered document to PDF bytes. */
export async function htmlToPdf(html: string, options: PdfOptions = {}): Promise<Buffer> {
  if (options.convert) return options.convert(html);

  const browser = options.browserPath ?? findBrowser(options.env);
  if (!browser) {
    throw new PdfConversionError(
      'No browser found to convert the document to PDF.\n' +
        'Install Chrome, Chromium or Edge, or set one of OPEN_NAV_BROWSER, ' +
        'CHROME_PATH or PUPPETEER_EXECUTABLE_PATH, or pass browserPath, ' +
        'or supply your own convert() — see PdfOptions.',
    );
  }
  return spawnConversion(html, browser, options);
}

async function spawnConversion(
  html: string,
  browser: string,
  options: PdfOptions,
): Promise<Buffer> {
  const workDir = mkdtempSync(join(tmpdir(), 'open-nav-pdf-'));
  const inputPath = join(workDir, 'invoice.html');
  const outputPath = join(workDir, 'invoice.pdf');

  try {
    writeFileSync(inputPath, html, 'utf8');

    const args = [
      '--headless',
      '--disable-gpu',
      '--no-pdf-header-footer',
      // Its own profile, so concurrent conversions do not fight over one.
      `--user-data-dir=${join(workDir, 'profile')}`,
      ...(options.sandbox === false ? ['--no-sandbox'] : []),
      ...(options.browserArgs ?? []),
      `--print-to-pdf=${outputPath}`,
      `file://${inputPath}`,
    ];

    const { code, stderr } = await run(browser, args, options.timeoutMs ?? 30_000);

    if (!existsSync(outputPath)) {
      throw new PdfConversionError(explainFailure(browser, code, stderr, options));
    }
    const pdf = readFileSync(outputPath);
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new PdfConversionError(
        `${browser} produced ${pdf.length} bytes that are not a PDF.\n${stderr.trim()}`,
      );
    }
    return pdf;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Turn a browser failure into something the caller can act on. */
function explainFailure(
  browser: string,
  code: number | null,
  stderr: string,
  options: PdfOptions,
): string {
  if (/without --no-sandbox is not supported/i.test(stderr)) {
    return (
      `${browser} refuses to run as root with its sandbox enabled.\n` +
      'Pass sandbox: false (or --no-sandbox on the CLI) if you accept that, ' +
      'which is usual in a container, or run as a non-root user.'
    );
  }
  if (options.sandbox === false && /sandbox/i.test(stderr)) {
    return `${browser} could not start even with the sandbox disabled.\n${stderr.trim()}`;
  }
  return `${browser} exited with code ${code ?? 'unknown'} and produced no PDF.\n${stderr.trim()}`;
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new PdfConversionError(
          `${command} did not finish within ${timeoutMs}ms. ` +
            'A logo fetched over the network is the usual cause; inline it instead.',
        ),
      );
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new PdfConversionError(`Could not run ${command}: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/** Environment variables that name a browser, in the order they are honoured. */
const BROWSER_ENV_VARS = ['OPEN_NAV_BROWSER', 'CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH'] as const;

const EXECUTABLE_NAMES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium-browser',
  'chromium',
  'microsoft-edge',
  'chrome',
];

const WELL_KNOWN_PATHS = [
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  // Linux
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * Locate a browser able to print to PDF.
 *
 * Order: an explicit environment variable, a Playwright install, the usual
 * install locations, then `PATH`.
 */
export function findBrowser(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const name of BROWSER_ENV_VARS) {
    const candidate = env[name];
    if (candidate && existsSync(candidate)) return candidate;
  }

  const fromPlaywright = findPlaywrightChromium(env['PLAYWRIGHT_BROWSERS_PATH']);
  if (fromPlaywright) return fromPlaywright;

  for (const candidate of WELL_KNOWN_PATHS) {
    if (existsSync(candidate)) return candidate;
  }

  const pathEntries = (env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const directory of pathEntries) {
    if (!directory) continue;
    for (const name of EXECUTABLE_NAMES) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return undefined;
}

/**
 * Playwright keeps its browsers in a versioned directory, so the exact path
 * is not predictable and has to be discovered.
 */
function findPlaywrightChromium(browsersPath: string | undefined): string | undefined {
  if (!browsersPath || !existsSync(browsersPath)) return undefined;

  const candidates: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(browsersPath);
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.startsWith('chromium')) continue;
    candidates.push(
      join(browsersPath, entry, 'chrome-linux', 'chrome'),
      join(browsersPath, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(browsersPath, entry, 'chrome-win', 'chrome.exe'),
    );
  }

  // Prefer a full build over the headless shell: the shell cannot print.
  candidates.sort(
    (left, right) => Number(left.includes('headless')) - Number(right.includes('headless')),
  );
  return candidates.find((candidate) => existsSync(candidate));
}
