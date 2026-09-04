# Conformance fixtures

Official NAV sample documents, used as this project's golden test corpus.

* `api-samples/` — 11 request envelopes, one per invoice service operation.
* `data-samples/` — 30 `InvoiceData` documents covering the cases that are
  genuinely hard to get right: aggregate (gyűjtő) invoices, advance
  (előleg) invoices and their final settlements, foreign currency with HUF
  conversion, single- and multi-invoice modification chains, corrections of a
  wrongly invoiced product, environmental product fee (termékdíj), sales
  between VAT groups, simplified invoices, private-person customers, and new
  means of transport exports.

`fixtures.json` maps each normalised filename back to NAV's original (which
carries spaces and accented characters, and in one case a trailing space before
the extension). Do not edit fixtures; refresh them with
`scripts/vendor_schemas.py`.

## Why these matter

This project has no access to NAV's test system in CI — that needs a
technical user's credentials, which cannot live in a public repository. These
fixtures are the substitute: every document here must survive a
parse → serialise round trip and schema validation. A change that breaks a
fixture is a change that would have been rejected by NAV.

## Known arithmetic errors in NAV's samples

Six of the thirty invoice samples do not add up. In each case other figures in
the *same document* contradict the offending one, so these are errors in the
published examples rather than rules this library has misunderstood:

| Fixture | Problem |
| --- | --- |
| `belfoldi-ertekesites-tobb-afa-tipus.xml` | Gross stated as `3263000.00`; its own net `2980000.00` plus VAT `283600.00` is `3263600.00` |
| `gyujtoszamla-1.xml` | Per-rate VAT of `60000.00` + `1304000.00` is `1364000.00`, but its own `invoiceVatAmount` is `1364640.00` |
| `harmadik-orszagbeli-devizas-szamla.xml` | Gross stated as `19120.40`; net is `19120.00` with no VAT, and its own `vatRateGrossAmount` says `19120.00` |
| `tagorszagi-devizas-szamla.xml` | The same `0.40` discrepancy, apparently copied from the third-country sample |
| `termekdijas-szamla.xml` | `invoiceVatAmount` stated as `280000.00`; its lines, its `vatRateVatAmount` and its gross total all say `280800.00` |
| `uj-kozlekedesi-eszkoz-export.xml` | Gross stated as `8000.40`; net is `8000.00` with no VAT, and its own `vatRateGrossAmount` says `8000.00` |

`packages/core/test/summary.test.ts` lists these explicitly rather than
excluding them quietly. If a schema refresh corrects one upstream, that test
fails and we notice.

These are documentation defects, not service defects — NAV's live validation
is what actually decides whether a report is accepted. They are worth knowing
about if you use these samples to calibrate your own implementation, which is
exactly what they invite you to do.
