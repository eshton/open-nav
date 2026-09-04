import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  MAX_LOGO_BYTES,
  ThemeError,
  buildStyles,
  embedImage,
  loadTheme,
  resolveTheme,
} from '../src/theme.js';
import { renderInvoiceHtml } from '../src/html.js';
import { sample } from './fixtures.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DAAAAEAAH2FzhVAAAAAElFTkSuQmCC',
  'base64',
);

describe('resolveTheme', () => {
  it('fills in defaults for everything omitted', () => {
    const theme = resolveTheme({ accentColor: '#0f4c81' });
    expect(theme.accentColor).toBe('#0f4c81');
    expect(theme.pageSize).toBe(DEFAULT_THEME.pageSize);
    expect(theme.fontFamily).toBe(DEFAULT_THEME.fontFamily);
  });

  it('ignores explicit undefined rather than overwriting a default', () => {
    expect(resolveTheme({ accentColor: undefined }).accentColor).toBe(DEFAULT_THEME.accentColor);
  });

  describe('validates values that reach the stylesheet', () => {
    it('accepts the colour forms CSS accepts', () => {
      for (const colour of [
        '#abc',
        '#a1b2c3',
        '#a1b2c3ff',
        'rgb(1,2,3)',
        'rgba(1,2,3,0.5)',
        'hsl(200 50% 40%)',
        'rebeccapurple',
      ]) {
        expect(() => resolveTheme({ accentColor: colour }), colour).not.toThrow();
      }
    });

    it('rejects a colour carrying a CSS escape', () => {
      // The mechanism this guards: closing the rule and adding another.
      expect(() =>
        resolveTheme({ accentColor: 'red; } body { display: none } .x {' }),
      ).toThrowError(ThemeError);
      expect(() => resolveTheme({ accentColor: 'url(http://evil/x)' })).toThrowError(ThemeError);
    });

    it('rejects a font stack containing braces or a url', () => {
      expect(() => resolveTheme({ fontFamily: 'Arial } * { color: red' })).toThrowError(ThemeError);
      expect(() => resolveTheme({ fontFamily: 'url(evil)' })).toThrowError(ThemeError);
      expect(() => resolveTheme({ fontFamily: '"DejaVu Sans", Arial, sans-serif' })).not.toThrow();
    });

    it('accepts lengths and length lists, and rejects other text', () => {
      expect(() => resolveTheme({ pageMargin: '16mm 14mm' })).not.toThrow();
      expect(() => resolveTheme({ baseFontSize: '10pt' })).not.toThrow();
      expect(() => resolveTheme({ pageMargin: 'calc(100% - 3px)' })).toThrowError(ThemeError);
    });

    it('accepts page sizes and orientations', () => {
      for (const size of ['A4', 'Letter', 'A4 landscape', '210mm 297mm']) {
        expect(() => resolveTheme({ pageSize: size }), size).not.toThrow();
      }
      expect(() => resolveTheme({ pageSize: 'A4; } @page { size: 1cm' })).toThrowError(ThemeError);
    });

    it('names the offending field so a bad theme is easy to fix', () => {
      expect(() => resolveTheme({ panelColor: 'nope!' })).toThrowError(/theme\.panelColor/);
    });
  });

  describe('logo', () => {
    it('accepts a data URI and an https URL', () => {
      expect(() =>
        resolveTheme({ logo: { src: `data:image/png;base64,${PNG.toString('base64')}` } }),
      ).not.toThrow();
      expect(() => resolveTheme({ logo: { src: 'https://example.com/logo.png' } })).not.toThrow();
    });

    it('rejects anything else, pointing at embedImage', () => {
      expect(() => resolveTheme({ logo: { src: './logo.png' } })).toThrowError(/embedImage/);
      expect(() => resolveTheme({ logo: { src: 'javascript:alert(1)' } })).toThrowError(ThemeError);
    });

    it('validates the width', () => {
      expect(() => resolveTheme({ logo: { src: 'https://x/y.png', width: '46mm' } })).not.toThrow();
      expect(() => resolveTheme({ logo: { src: 'https://x/y.png', width: 'huge' } })).toThrowError(
        ThemeError,
      );
    });
  });
});

describe('embedImage', () => {
  it('inlines an image as a data URI', () => {
    expect(embedImage('logo.png', PNG)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('knows the common image types, by extension', () => {
    expect(embedImage('a.svg', Buffer.from('<svg/>'))).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(embedImage('a.JPG', PNG)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('refuses a type a browser may not render', () => {
    expect(() => embedImage('logo.tiff', PNG)).toThrowError(/Unsupported image type/);
  });

  it('refuses an image large enough to bloat every document', () => {
    const huge = Buffer.alloc(MAX_LOGO_BYTES + 1);
    expect(() => embedImage('big.png', huge)).toThrowError(/limit is/);
  });
});

describe('loadTheme', () => {
  const files: Record<string, string> = {
    '/brand/theme.json': JSON.stringify({
      accentColor: '#0f4c81',
      logoFile: 'logo.png',
      logo: { width: '40mm' },
      footerLines: ['Bank: 12345678-12345678'],
    }),
    '/brand/broken.json': '{ not json',
  };
  const io = {
    readFile: (path: string) => {
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    readBinary: () => PNG,
  };

  it('inlines logoFile relative to the theme file', () => {
    const theme = loadTheme('/brand/theme.json', io);
    expect(theme.logo?.src).toMatch(/^data:image\/png;base64,/);
    // Other logo fields survive the merge.
    expect(theme.logo?.width).toBe('40mm');
    expect(theme.footerLines).toEqual(['Bank: 12345678-12345678']);
  });

  it('does not leave logoFile in the theme it returns', () => {
    expect(loadTheme('/brand/theme.json', io)).not.toHaveProperty('logoFile');
  });

  it('says what is wrong with a malformed file', () => {
    expect(() => loadTheme('/brand/broken.json', io)).toThrowError(/not valid JSON/);
  });
});

describe('buildStyles', () => {
  it('puts the theme values into the stylesheet', () => {
    const css = buildStyles(resolveTheme({ accentColor: '#0f4c81', pageSize: 'Letter' }));
    expect(css).toContain('--accent: #0f4c81');
    expect(css).toContain('size: Letter');
  });

  it('adds zebra striping only when asked', () => {
    expect(buildStyles(resolveTheme({ zebraRows: true }))).toContain('nth-child(even)');
    expect(buildStyles(resolveTheme({}))).not.toContain('nth-child(even)');
  });

  it('appends customCss verbatim, as the escape hatch', () => {
    const css = buildStyles(resolveTheme({ customCss: '.invoice { outline: 1px solid red; }' }));
    expect(css).toContain('.invoice { outline: 1px solid red; }');
  });
});

describe('a themed document', () => {
  const invoice = () => sample('belfoldi-termekertekesites.xml');

  it('shows the logo, the contact block and the footer lines', () => {
    const html = renderInvoiceHtml(invoice(), {
      theme: {
        logo: {
          src: `data:image/png;base64,${PNG.toString('base64')}`,
          width: '40mm',
          alt: 'Acme',
        },
        issuerContact: ['+36 1 234 5678', 'hello@example.com'],
        footerLines: ['Bank: 12345678-12345678'],
      },
    });
    expect(html).toContain('class="logo"');
    expect(html).toContain('alt="Acme"');
    expect(html).toContain('width:40mm');
    expect(html).toContain('+36 1 234 5678');
    expect(html).toContain('Bank: 12345678-12345678');
  });

  it('falls back to the supplier name as the logo alt text', () => {
    const html = renderInvoiceHtml(invoice(), {
      theme: { logo: { src: `data:image/png;base64,${PNG.toString('base64')}` } },
    });
    expect(html).toContain('alt="Értékesítő Kft"');
  });

  it('escapes theme text, which is still input', () => {
    const html = renderInvoiceHtml(invoice(), {
      theme: { footerLines: ['<script>alert(1)</script>'], issuerContact: ['<b>x</b>'] },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('keeps the document self-contained with an inlined logo', () => {
    const html = renderInvoiceHtml(invoice(), {
      theme: { logo: { src: `data:image/png;base64,${PNG.toString('base64')}` } },
    });
    expect(html).not.toMatch(/src="http/);
  });

  it('can drop the provenance note from the theme', () => {
    expect(renderInvoiceHtml(invoice(), { theme: { provenanceNote: false } })).not.toContain(
      'megjelenítés',
    );
    // The per-document option still wins over the shared theme.
    expect(
      renderInvoiceHtml(invoice(), { theme: { provenanceNote: false }, provenanceNote: true }),
    ).toContain('megjelenítés');
  });

  it('still renders every published sample with a theme applied', () => {
    const theme = { accentColor: '#0f4c81', zebraRows: true };
    for (const name of [
      'gyujtoszamla-1.xml',
      'belfoldi-devizas-szamla.xml',
      'belfoldi-egyszerusitett-szamla.xml',
    ]) {
      expect(() => renderInvoiceHtml(sample(name), { theme }), name).not.toThrow();
    }
  });
});
