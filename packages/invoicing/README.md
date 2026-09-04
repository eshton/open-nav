# @open-nav/invoicing

Turn NAV invoice data into the two documents an invoicing program has to be
able to produce: a printable invoice, and the tax authority data export.

## The printable invoice

```ts
import { renderInvoiceHtml } from '@open-nav/invoicing';

const html = renderInvoiceHtml(invoice, { language: 'hu' });
```

```sh
open-nav render invoice.xml --out invoice.html
chromium --headless --print-to-pdf=invoice.pdf invoice.html
```

**Why HTML and not PDF directly.** A Hungarian invoice needs `ő` and `ű`.
Both are outside WinAnsi, the encoding the PDF core fonts use, so a
dependency-free PDF writer cannot spell the language without bundling and
licensing a font. HTML gets the typography right, needs nothing bundled, and
any browser turns it into a PDF that embeds the font subsets it needs. The
output has no external references — no fonts, scripts or images fetched — so
it renders the same offline and archives as a single file.

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
