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

A Hungarian invoice needs `ő` and `ű`. Both are outside WinAnsi, the encoding
the PDF core fonts use, so a dependency-free PDF writer cannot spell the
language without bundling, licensing and subsetting a font. A browser already
has fonts, already subsets and embeds them, and already implements `@page` —
so the document is rendered as HTML and converted. The tests assert
`/FontFile2` appears in the output, which is that font subset.

`findBrowser()` locates Chrome, Chromium or Edge: an explicit
`OPEN_NAV_BROWSER`, `CHROME_PATH` or `PUPPETEER_EXECUTABLE_PATH`, then a
Playwright install, then the usual locations, then `PATH`. It prefers a full
build over a headless shell, which cannot print.

**The sandbox stays on by default.** Invoice data is input, and the sandbox is
what contains a malicious document. That means conversion fails when running
as root, as in most containers — pass `sandbox: false`, or `--no-sandbox`,
deliberately. The error says exactly that rather than quietly weakening the
default for everyone.

No browser at all? Supply your own converter:

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

const pdf = await renderInvoicePdf(invoice, { convert });
```

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
