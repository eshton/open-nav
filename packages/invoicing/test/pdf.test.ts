import { describe, expect, it } from 'vitest';
import { PdfConversionError, findBrowser, htmlToPdf, renderInvoicePdf } from '../src/pdf.js';
import { renderInvoiceHtml } from '../src/html.js';
import { sample } from './fixtures.js';

/**
 * PDF conversion.
 *
 * The tests that need a browser run only where one exists, so the suite
 * passes on a machine without Chrome. The conversion itself is still
 * exercised wherever it can be — including in this project's own CI, which
 * has Chromium.
 */

const browser = findBrowser();
const withBrowser = browser ? describe : describe.skip;

describe('findBrowser', () => {
  it('honours an explicit environment variable', () => {
    // Any existing file will do; the point is the precedence.
    expect(findBrowser({ OPEN_NAV_BROWSER: process.execPath })).toBe(process.execPath);
    expect(findBrowser({ CHROME_PATH: process.execPath })).toBe(process.execPath);
    expect(findBrowser({ PUPPETEER_EXECUTABLE_PATH: process.execPath })).toBe(process.execPath);
  });

  it('ignores a variable pointing at nothing', () => {
    expect(findBrowser({ OPEN_NAV_BROWSER: '/nonexistent/chrome', PATH: '' })).toBeUndefined();
  });

  it('finds nothing when there is nothing to find', () => {
    expect(findBrowser({ PATH: '/nonexistent' })).toBeUndefined();
  });

  it('prefers a full build over a headless shell, which cannot print', () => {
    // Playwright installs both; only the full build implements print-to-PDF.
    if (!process.env['PLAYWRIGHT_BROWSERS_PATH']) return;
    const found = findBrowser();
    expect(found).toBeTruthy();
    expect(found).not.toContain('headless_shell');
  });
});

describe('conversion contract', () => {
  it('uses a caller-supplied converter instead of a browser', async () => {
    const seen: string[] = [];
    const pdf = await htmlToPdf('<p>x</p>', {
      convert: async (html) => {
        seen.push(html);
        return Buffer.from('%PDF-1.7 fake');
      },
    });
    expect(seen).toEqual(['<p>x</p>']);
    expect(pdf.toString()).toContain('%PDF-1.7');
  });

  it('passes the rendered document to the converter', async () => {
    let captured = '';
    await renderInvoicePdf(sample('belfoldi-termekertekesites.xml'), {
      theme: { accentColor: '#0f4c81' },
      convert: async (html) => {
        captured = html;
        return Buffer.from('%PDF-');
      },
    });
    expect(captured).toContain('--accent: #0f4c81');
    expect(captured).toContain('Értékesítő Kft');
  });

  it('explains that no browser was found, and how to supply one', async () => {
    const failure = await htmlToPdf('<p>x</p>', { env: { PATH: '/nonexistent' } }).catch(
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(PdfConversionError);
    // The message has to name the ways out, or the caller is stuck.
    expect(failure.message).toContain('OPEN_NAV_BROWSER');
    expect(failure.message).toContain('browserPath');
    expect(failure.message).toContain('convert()');
  });

  it('reports a browser path that cannot be run', async () => {
    await expect(
      htmlToPdf('<p>x</p>', { browserPath: '/nonexistent/chrome' }),
    ).rejects.toThrowError(/Could not run/);
  });
});

withBrowser('against a real browser', () => {
  /** Running as root, Chrome needs its sandbox disabled. */
  const sandbox = process.getuid?.() === 0 ? { sandbox: false } : {};

  it('produces a real PDF from an invoice', async () => {
    const pdf = await renderInvoicePdf(sample('belfoldi-termekertekesites.xml'), sandbox);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(10_000);
  }, 60_000);

  it('embeds fonts, which is what makes ő and ű come out right', async () => {
    // The reason this goes through a browser at all: the PDF core fonts
    // cannot represent these characters, so a font must be subset in.
    const pdf = await renderInvoicePdf(sample('belfoldi-termekertekesites.xml'), sandbox);
    expect(pdf.toString('latin1')).toContain('/FontFile2');
  }, 60_000);

  it('applies the theme to the PDF', async () => {
    const plain = await renderInvoicePdf(sample('belfoldi-termekertekesites.xml'), sandbox);
    const themed = await renderInvoicePdf(sample('belfoldi-termekertekesites.xml'), {
      ...sandbox,
      theme: { accentColor: '#0f4c81', zebraRows: true },
    });
    expect(themed.length).not.toBe(plain.length);
  }, 60_000);

  it('says exactly what to do when the sandbox blocks it', async () => {
    if (process.getuid?.() !== 0) return;
    await expect(
      renderInvoicePdf(sample('belfoldi-termekertekesites.xml'), { sandbox: true }),
    ).rejects.toThrowError(/--no-sandbox/);
  }, 60_000);

  it('gives up rather than hanging', async () => {
    await expect(
      htmlToPdf(renderInvoiceHtml(sample('belfoldi-termekertekesites.xml')), {
        ...sandbox,
        timeoutMs: 1,
      }),
    ).rejects.toThrowError(/did not finish/);
  }, 30_000);
});
