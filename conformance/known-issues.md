# Known issues in NAV's own sample documents

The 41 documents under `conformance/` are vendored verbatim from NAV and used
as the golden test corpus. Six of the thirty sample **invoices** do not add up:
their stated summaries contradict their own line data and, in every case, other
figures inside the same document. These are errors in NAV's examples, not in
this library's rules.

They are recorded here, and asserted in
[`packages/core/test/summary.test.ts`](../packages/core/test/summary.test.ts)
as `KNOWN_UPSTREAM_ERRORS`, for one reason: so that a future contributor does
**not** try to make them reconcile. The reconciliation code is correct; these
samples are wrong. If you change the summary rules until all thirty pass, you
have broken the rules to fit six bad inputs.

## Why they are warnings, not fixes

`checkInvoiceSummary` reports each discrepancy with the `SUMMARY_MISMATCH`
fault code — the same verdict NAV's own validator would return. The test pins
the **exact** set of mismatching paths for each of the six, so:

- if a schema refresh corrects one upstream, the test fails (fewer mismatches
  than recorded) and we notice; and
- if a change to the rules starts flagging a _different_ path, the test fails
  (the path set no longer matches) and we notice.

Either way the six are a tripwire, not a blind allow-list.

## The six documents

| Sample | Mismatching figure | Why the sample is wrong |
| --- | --- | --- |
| `belfoldi-ertekesites-tobb-afa-tipus.xml` | `invoiceGrossAmount`, `invoiceGrossAmountHUF` | States gross `3263000.00`, but its own net `2980000.00` plus VAT `283600.00` is `3263600.00`. |
| `gyujtoszamla-1.xml` | `summaryByVatRate.1.vatRateVatData.vatRateVatAmount` | Per-rate VAT `60000.00 + 1304000.00` is `1364000.00`, but its own `invoiceVatAmount` is `1364640.00`. |
| `harmadik-orszagbeli-devizas-szamla.xml` | `invoiceGrossAmount` | States gross `19120.40`, but net `19120.00` with `0.00` VAT — and its own `vatRateGrossAmount` — are `19120.00`. |
| `tagorszagi-devizas-szamla.xml` | `invoiceGrossAmount` | The same `0.40` discrepancy as the third-country sample it was copied from. |
| `termekdijas-szamla.xml` | `invoiceVatAmount`, `invoiceVatAmountHUF` | States `invoiceVatAmount 280000.00`, but its lines, its `vatRateVatAmount` and its gross total all say `280800.00`. |
| `uj-kozlekedesi-eszkoz-export.xml` | `invoiceGrossAmount` | States gross `8000.40`, but net `8000.00` with `0.00` VAT — and its own `vatRateGrossAmount` — are `8000.00`. |

The other 24 sample invoices reconcile with no findings, and this library
reproduces their summaries exactly.
