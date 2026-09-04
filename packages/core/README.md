# @open-nav/core

The parts of the NAV Online Számla interface that have a right answer:
authentication, the schema, XML, exact decimal arithmetic and validation.
No network access — everything here is pure, so it is testable and safe to
run anywhere.

```sh
npm install @open-nav/core
```

## Authentication

Every request NAV accepts carries a SHA-512 password hash and a SHA3-512
request signature. The signature is not over the request body: it is over
`requestId + yyyyMMddHHmmss + signKey`, followed by a **concatenation of
per-invoice hashes in index order** when the operation submits invoices.

```ts
import { passwordHash, requestSignature, createRequestId } from '@open-nav/core';

const requestId = createRequestId(); // safe against the 30 char / [+a-zA-Z0-9_] rule
const timestamp = new Date();

const signature = requestSignature(requestId, timestamp, process.env.NAV_SIGN_KEY!, [
  { index: 1, operation: 'CREATE', base64Payload: encoded },
]);
const hash = passwordHash(process.env.NAV_PASSWORD!); // the SHA-512 half
```

Verified against **all 11 of NAV's published request samples**, the
three-invoice batch included, which is the case that catches an
implementation that hashes in the wrong order or hashes a re-serialised copy
of the payload.

`decodeExchangeToken` handles the other half: the token NAV returns is
AES-128-ECB encrypted with your exchange key, and arrives padded or unpadded
depending on the operation.

## The schema, generated from the XSDs

The types and the runtime metadata that drives serialisation, parsing and
validation are generated from NAV's own XSDs — ~700 elements across six
namespaces — and must not be hand-edited. One descriptor table drives all
three directions, so they cannot disagree with each other.

```ts
import {
  serializeDocument,
  parseDocumentAs,
  encodeInvoiceData,
  decodeInvoiceData,
} from '@open-nav/core';

const xml = serializeDocument('InvoiceData', document);
const back = parseDocumentAs<InvoiceData>(xml, 'InvoiceData');
const base64 = encodeInvoiceData(document); // what goes in the request
```

All **41 official NAV sample documents** round-trip to canonically equal XML.

Namespaces are the trap worth naming: a tax number sits in `OSA/3.0/data`
while its `taxpayerId` child sits in `OSA/3.0/base`. The generated
descriptors know which, so you never write a prefix.

## Exact arithmetic

Invoice amounts run to 18 digits and quantities to 10 decimal places. IEEE
754 doubles cannot carry either, and being one forint out rejects the whole
batch, so amounts are **decimal strings end to end** and arithmetic goes
through `Decimal`, which is BigInt-scaled.

```ts
import { Decimal, computeInvoiceSummary, checkInvoiceSummary } from '@open-nav/core';

Decimal.from('0.1').add('0.2').toString(); // '0.3', not 0.30000000000000004

const invoice = document.invoiceMain.invoice!; // an InvoiceType
const summary = computeInvoiceSummary(invoice); // per VAT rate, plus the totals
const findings = checkInvoiceSummary(invoice); // where it fails to reconcile
```

Summation is not the whole rule. A line that omits its VAT amount has it
**derived from the rate**, a VAT exemption is identified by its legal case
and not by the free text beside it, and a foreign-currency invoice needs a
forint twin for every amount. Reproduces the summaries of 24 of NAV's 30
sample invoices; the remaining 6 are internally contradictory upstream — see
[`conformance/README.md`](../../conformance/README.md).

## Validating before NAV does

Two layers, both local: the generated schema, and the business rules that are
`INVALID_...` faults in NAV's catalogue.

```ts
import { validateInvoice, faultMessage } from '@open-nav/core';

const report = validateInvoice(document, { operation: 'CREATE', language: 'hu' });
if (!report.valid) {
  for (const issue of report.errors) {
    console.error(issue.path, issue.code, issue.message, issue.navMessage);
  }
}
faultMessage('ANNULMENT_IN_PROGRESS', 'hu'); // NAV's own wording, in hu, en or de
```

Findings carry NAV's own fault code where one exists, so an error you see
locally is the error you would have seen remotely. The catalogue is generated
from `schemas/i18n/` — 236 codes, in Hungarian, English and German. It covers
NAV's _business validation_ codes; the technical ones (`INVALID_SIGNATURE`,
`INVALID_REQUEST_ID` and the rest) are not in NAV's message files, and arrive
with their own text on the response instead.

Rules NAV can only decide server-side — whether the invoice number is
already used, whether the customer's tax number is live — are listed in
`LOCALLY_UNDECIDABLE` rather than guessed at.

Warnings do not make a report invalid, and that distinction is load-bearing:
the taxpayer-id check digit is a warning because 2 of the 4 tax numbers in
NAV's own samples fail it while NAV itself validates against its registry. A
validator that cries wolf gets switched off.

## Also here

`OPERATIONS`, `BASE_URLS`, `MAX_INVOICE_BATCH_SIZE`, `QUERY_PAGE_SIZE` and
the other interface constants; `parseTaxNumber` and the county/VAT-code
tables; NAV's timestamp formats; and the `NavError` hierarchy the client
throws.

## Licence

MIT. Not affiliated with NAV.
