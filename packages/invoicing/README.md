# @open-nav/invoicing

Turn NAV invoice data into the two documents an invoicing program has to be
able to produce: a printable invoice, and the tax authority data export.

## The printable invoice

```sh
open-nav render invoice.xml --pdf invoice.pdf --theme theme.json
```

```ts
import { renderInvoicePdf, renderInvoiceHtml, loadTheme } from '@open-nav/invoicing';

const theme = loadTheme('theme.json');
const pdf = await renderInvoicePdf(invoice, { theme }); // Buffer
const html = renderInvoiceHtml(invoice, { theme }); // string
```

### Styling

Everything visual comes from a theme, which can live in a JSON file next to
its logo — see [`examples/invoice-theme.json`](../../examples/invoice-theme.json).

| Field                                                 | Purpose                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `accentColor`                                         | Title, the grand total, the rule above it                              |
| `inkColor`, `mutedColor`, `panelColor`, `borderColor` | The rest of the palette                                                |
| `fontFamily`, `baseFontSize`                          | Typography; everything scales from the base size                       |
| `pageSize`, `pageMargin`                              | `@page` setup, e.g. `A4` and `16mm 14mm`                               |
| `logo` / `logoFile`                                   | Header logo. `logoFile` is read relative to the theme file and inlined |
| `issuerContact`                                       | Extra lines in the supplier block: phone, email, web                   |
| `footerLines`                                         | Footer: payment terms, company registration, bank details              |
| `zebraRows`                                           | Tint alternate table rows                                              |
| `provenanceNote`                                      | Whether to print the "rendered from reported data" line                |
| `customCss`                                           | Appended after the generated stylesheet. The escape hatch              |

Theme values end up inside the stylesheet, so they are **validated rather
than interpolated**: a colour must look like a CSS colour, a font stack may
not contain parentheses (no font name does, and allowing them would admit
`url(...)`), and a logo must be a `data:` URI or an `http(s)` URL. A bad value
names the field it came from.

`--logo` on the command line overrides the theme's, so one branded theme can
be shared and a single document still overridden.

### How the PDF is made, and why

`ő` and `ű` are the whole difficulty. Both lie outside WinAnsi, the encoding
the PDF core fonts use, so **a font has to be embedded** for a Hungarian
invoice to spell itself. (This is not hypothetical: of the fonts installed on
the machine this was developed on, one — Loma — is missing exactly those four
characters and nothing else.)

There are two engines, and the default needs nothing installed.

**`native`** — the default. pdfmake lays the document out, pdfkit writes the
PDF, and the Roboto files pdfmake bundles supply the glyphs. Roboto covers
Latin Extended-A, is Apache-2.0, and embeds as a subset with a correct
ToUnicode map, so the text stays searchable and copyable. Output is around a
quarter the size of a browser's.

```ts
const pdf = await renderInvoicePdf(invoice, { theme }); // native
```

Bring your own font if the brand needs one:

```ts
const pdf = await renderInvoicePdf(invoice, {
  theme,
  font: { name: 'Inter', normal: 'fonts/Inter-Regular.ttf', bold: 'fonts/Inter-SemiBold.ttf' },
});
```

**`browser`** — renders the HTML document and converts it with Chrome,
Chromium or Edge. It follows the HTML exactly, which matters if you have
styled it with `customCss` beyond what the native layout reproduces.

```sh
open-nav render invoice.xml --pdf invoice.pdf --engine browser --no-sandbox
```

`findBrowser()` locates one: an explicit `OPEN_NAV_BROWSER`, `CHROME_PATH` or
`PUPPETEER_EXECUTABLE_PATH`, then a Playwright install, then the usual
locations, then `PATH` — preferring a full build over a headless shell, which
cannot print. Or supply `convert` and use Playwright directly:

```ts
import { chromium } from 'playwright';

const convert = async (html: string) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  const pdf = await page.pdf({ printBackground: true });
  await browser.close();
  return pdf;
};

const pdf = await renderInvoicePdf(invoice, { convert }); // implies browser
```

**The browser sandbox stays on by default.** Invoice data is input, and the
sandbox is what contains a malicious document, so conversion fails as root —
usual in a container. Pass `sandbox: false`, or `--no-sandbox`, deliberately.

The native engine has no such exposure: it fetches nothing and reads nothing
but the font files it registered, both enforced through pdfmake's access
policies rather than left at their permissive defaults.

### The two engines are two layouts

They follow the same theme, but the native engine builds the page from
pdfmake's document model rather than CSS, so **they will not match pixel for
pixel**. Known differences: party boxes have square corners rather than
rounded, an SVG logo is skipped because pdfmake cannot rasterise one (use PNG
or JPEG), and `customCss` applies only to HTML. The native engine adds page
numbers when a document runs to more than one page.

The HTML has no external references — no fonts, scripts or images fetched — so
it renders the same offline and archives as a single file. Keep the logo
inlined for that reason; a logo fetched over the network is the usual cause of
a conversion that hangs, or a PDF that silently comes out logo-less.

### It derives the markings the law requires

Section 169 of the VAT Act prescribes more than figures. An exempt supply must
state its legal ground, a domestic reverse charge must say _fordított adózás_,
cash accounting must say _pénzforgalmi elszámolás_, a margin scheme must name
which one. These are derived from the invoice data and printed with the
provision they come from, because a missing phrase makes an invoice defective
even when every number on it is right:

```text
JOGSZABÁLYI JELÖLÉSEK
  • fordított adózás (Áfa tv. 169. § n))
  • különbözet szerinti szabályozás – használt cikkek (Áfa tv. 169. § o) p))
  • Adómentes — TAM — Mentes ÁFA tv. 85.§ (1) i) (Áfa tv. 169. § m))
```

Also handled: simplified and aggregate invoices get their own title, a
modification document names the invoice it amends, a foreign-currency invoice
shows the rate and the forint total, a private person is never named, and a
batch document renders each invoice on its own page.

Amounts are formatted from the exact decimal strings, never through a
JavaScript number, so an 18 digit total survives to the page.

## The data export

Decree **23/2014. (VI. 30.) NGM** requires every invoicing program to have a
built-in _adóhatósági ellenőrzési adatszolgáltatás_ function that exports the
invoices issued in a date range, or in an invoice number range, as XML.

```sh
open-nav export invoices/*.xml --out export/ --from 2024-01-01 --to 2024-12-31
```

Two structures are permitted. Annexes 2 and 3 of the decree define one
(`szamla.xsd`); **section 13/A(1)** permits the other — the structure
published for the online invoice data service, which is `invoiceData.xsd`.
This produces the second, because it is the schema this project already
generates, validates and round-trips against NAV's own documents.

That choice belongs to the taxpayer. **If your auditor asks for the Annex 3
structure specifically, this export is not it.**

The export writes one XML per invoice plus a `manifest.json` recording what
was selected, the structure used with the provision that permits it, and the
SHA-256 of every file — so the export can later be shown to be the one that
was produced.

### Invoice number ranges order naturally

Selecting `2024/1` to `2024/10` by plain text comparison excludes `2024/9`,
because `"2024/9" > "2024/10"` as text. Digit runs are therefore compared as
numbers by default, so a requested range does not silently lose invoices from
the middle of it. Pass `compareInvoiceNumbers` if your numbering needs
something else.

## What this does not claim

It does not make anyone's invoicing program compliant. Gapless numbering,
immutable storage and the audit trail are the issuer's obligations, and a
rendered document is a presentation of reported data, not the legal original.

## Licence

MIT. Not affiliated with NAV.
