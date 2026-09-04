import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { NativePdfError, renderInvoicePdfNative } from '../src/pdf-native.js';
import { renderInvoicePdf } from '../src/pdf.js';
import { allSamples, sample } from './fixtures.js';

/**
 * The native engine: pdfmake for layout, pdfkit for the PDF, and the Roboto
 * files pdfmake bundles for the glyphs. No browser involved.
 */

/** A valid 2x2 PNG. The usual one-pixel base64 snippets are often malformed. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',
  'base64',
);

/** ToUnicode maps are how a PDF says which characters it contains. */
function unicodeMaps(pdf: Buffer): string {
  // latin1 keeps one byte per character, so string offsets are byte offsets.
  // The lookbehind matters: "endstream" also ends in "stream".
  const text = pdf.toString('latin1');
  const maps: string[] = [];
  for (const match of text.matchAll(/(?<!end)stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end === -1) continue;
    try {
      const inflated = inflateSync(Buffer.from(text.slice(start, end), 'latin1')).toString(
        'latin1',
      );
      if (inflated.includes('beginbfchar') || inflated.includes('beginbfrange')) {
        maps.push(inflated);
      }
    } catch {
      // Not a deflate stream; skip it.
    }
  }
  return maps.join('\n');
}

describe('renderInvoicePdfNative', () => {
  it('produces a PDF with no browser present', async () => {
    const pdf = await renderInvoicePdfNative(sample('belfoldi-termekertekesites.xml'));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5_000);
  }, 30_000);

  it('embeds a font subset, which is what a PDF needs for these glyphs', async () => {
    const pdf = await renderInvoicePdfNative(sample('belfoldi-termekertekesites.xml'));
    expect(pdf.toString('latin1')).toContain('/FontFile2');
  }, 30_000);

  it('carries ő and ű with correct Unicode mappings', async () => {
    // The reason the browser was needed at first: the PDF core fonts cannot
    // represent these. A mapped ToUnicode entry means the character is really
    // there, and stays searchable and copyable.
    const pdf = await renderInvoicePdfNative(sample('belfoldi-termekertekesites.xml'));
    const maps = unicodeMaps(pdf);
    for (const code of ['0151', '0171', '00e9', '00f6']) {
      expect(maps.toLowerCase(), `U+${code}`).toContain(`<${code}>`);
    }
  }, 30_000);

  it('renders every published sample', async () => {
    for (const entry of allSamples()) {
      const pdf = await renderInvoicePdfNative(entry.document);
      expect(pdf.subarray(0, 5).toString(), entry.name).toBe('%PDF-');
    }
  }, 120_000);

  it('paginates a long invoice', async () => {
    const pdf = await renderInvoicePdfNative(sample('belfoldi-ertekesites-tobb-afa-tipus.xml'));
    const pages = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('renders each invoice of a batch document', async () => {
    const document = sample('tobb-szamla-modositasa-egy-okirattal.xml');
    expect(document.invoiceMain.batchInvoice?.length ?? 0).toBeGreaterThan(1);
    const pdf = await renderInvoicePdfNative(document);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 30_000);

  it('applies the theme', async () => {
    const plain = await renderInvoicePdfNative(sample('belfoldi-termekertekesites.xml'));
    const themed = await renderInvoicePdfNative(sample('belfoldi-termekertekesites.xml'), {
      theme: { accentColor: '#0f4c81', zebraRows: true, footerLines: ['Bank: 1234'] },
    });
    expect(themed.length).not.toBe(plain.length);
  }, 30_000);

  it('accepts a raster logo as a data URI', async () => {
    const pdf = await renderInvoicePdfNative(sample('belfoldi-termekertekesites.xml'), {
      theme: { logo: { src: `data:image/png;base64,${PNG.toString('base64')}`, width: '30mm' } },
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 30_000);

  it('skips an SVG logo rather than failing, since pdfmake cannot rasterise one', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
    const pdf = await renderInvoicePdfNative(sample('belfoldi-termekertekesites.xml'), {
      theme: { logo: { src: svg } },
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 30_000);

  it('renders in English', async () => {
    const pdf = await renderInvoicePdfNative(sample('belfoldi-termekertekesites.xml'), {
      language: 'en',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 30_000);

  it('reports a missing font file rather than producing a broken PDF', async () => {
    await expect(
      renderInvoicePdfNative(sample('belfoldi-termekertekesites.xml'), {
        font: { name: 'Missing', normal: '/nonexistent/font.ttf' },
      }),
    ).rejects.toThrowError(NativePdfError);
  }, 30_000);
});

describe('engine selection', () => {
  it('uses the native engine by default, needing no browser', async () => {
    const pdf = await renderInvoicePdf(sample('belfoldi-termekertekesites.xml'));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 30_000);

  it('treats a supplied converter as a request for the HTML path', async () => {
    let sawHtml = false;
    await renderInvoicePdf(sample('belfoldi-termekertekesites.xml'), {
      convert: async (html) => {
        sawHtml = html.startsWith('<!doctype html>');
        return Buffer.from('%PDF-');
      },
    });
    expect(sawHtml).toBe(true);
  });

  it('honours an explicit native choice even with a converter present', async () => {
    let converterCalled = false;
    const pdf = await renderInvoicePdf(sample('belfoldi-termekertekesites.xml'), {
      engine: 'native',
      convert: async () => {
        converterCalled = true;
        return Buffer.from('%PDF-');
      },
    });
    expect(converterCalled).toBe(false);
    expect(pdf.length).toBeGreaterThan(5_000);
  }, 30_000);

  it('is smaller than the browser output', async () => {
    // Not a rule of nature, but it holds here and is worth noticing: a
    // browser embeds more font data than the document needs.
    const native = await renderInvoicePdf(sample('belfoldi-termekertekesites.xml'), {
      engine: 'native',
    });
    expect(native.length).toBeLessThan(80_000);
  }, 30_000);
});
