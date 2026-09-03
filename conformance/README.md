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
