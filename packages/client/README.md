# @open-nav/client

Client for all ten operations of NAV's **Online Számla** invoice service
(interface 3.0), plus the transaction polling and bulk download that using it
actually requires.

```sh
npm install @open-nav/client
```

## The client

```ts
import { NavClient, waitForTransaction } from '@open-nav/client';

const client = new NavClient({
  environment: 'test', // or 'production'
  credentials: {
    login: process.env.NAV_LOGIN!,
    password: process.env.NAV_PASSWORD!,
    signKey: process.env.NAV_SIGN_KEY!,
    exchangeKey: process.env.NAV_EXCHANGE_KEY!,
    taxNumber: '12345678', // the 8 digit core, not the 11 digit number
  },
  software: {
    softwareId: 'MYCOMPANY0000001',
    softwareName: 'my invoicing app',
    softwareOperation: 'LOCAL_SOFTWARE',
    softwareMainVersion: '1.0.0',
    softwareDevName: 'My Company',
    softwareDevContact: 'dev@example.com',
  },
});
```

Each method takes its generated request type **minus** the `header`, `user`
and `software` blocks, which the client builds and signs itself. There is no
hand-maintained parameter list to fall out of step with the schema.

`tokenExchange`, `manageInvoice`, `manageAnnulment`,
`queryTransactionStatus`, `queryTransactionList`, `queryInvoiceData`,
`queryInvoiceDigest`, `queryInvoiceChainDigest`, `queryInvoiceCheck` and
`queryTaxpayer` are all there, one method each, named as NAV names them.

## Submitting

```ts
const { transactionId } = await client.submitInvoices([{ operation: 'CREATE', invoice }]);

const outcome = await waitForTransaction(client, transactionId);
console.log(outcome.accepted.length, 'stored;', outcome.rejected.length, 'rejected');
```

`submitInvoices` is the reason this package is worth using over a hand-rolled
request. It exchanges a token, encodes each invoice **once** and both sends
and hashes that same base64 — hashing a separately serialised copy is a
signature failure waiting to happen — and it **never retries a submission
that reached NAV**, because the retry would be a duplicate invoice report,
not a repeated read.

`manageInvoice` returns a transaction id, not a verdict. The verdict arrives
later, per invoice, split across _technical_ and _business_ validation
messages, and `waitForTransaction` polls the lifecycle
(`RECEIVED → PROCESSING → SAVED → DONE`/`ABORTED`) and sorts the outcome into
accepted and rejected invoices with their messages attached.

`submitAnnulments` does the same for technical annulment.

## Downloading invoices

The queries have a **35-day cap** per request and page at 100 results, which
makes "give me last year's incoming invoices" a loop rather than a call. That
loop is here:

```ts
import { downloadInvoices, iterateInvoiceDigests } from '@open-nav/client';

const invoices = await downloadInvoices(client, {
  direction: 'INBOUND',
  dateFrom: '2025-01-01',
  dateTo: '2025-12-31',
});

// or stream, if a year of invoices should not be held in memory at once
for await (const digest of iterateInvoiceDigests(client, {
  direction: 'OUTBOUND',
  dateFrom,
  dateTo,
})) {
  // ...
}
```

`chunkDateRange` splits the range into legal windows, pagination is followed
to the end, and `supplierTaxNumber` is sent **only** for `INBOUND` — sending
it on an outbound query is `BAD_QUERY_PARAM_SUPPLIER_NOT_EXPECTED`, and
omitting it on an inbound one returns nothing.

## Transport

`postXml` is the layer underneath, and it is deliberately conservative:

- **429 and 503 are retried**, honouring `Retry-After` (capped at 60s).
  Everything else in the 4xx range is fatal — a retry would not change the
  answer.
- **Submissions are never retried.** Only reads are.
- NAV's `GeneralErrorResponse` becomes a `NavApiError` carrying the fault
  code and NAV's own message, so `INVALID_SIGNATURE` reads as itself rather
  than as an HTTP 500.

Credentials never appear in a thrown error, a log line or a serialised
request beyond the hash and signature NAV requires — there are tests that
assert the password, sign key and exchange key never reach the wire.

## Testing without credentials

[`@open-nav/mock-server`](../mock-server) is a local stand-in for the
service: real HTTP, its own independent signature verification, and the same
error codes. This client is driven end to end against it in CI — token
exchange, batch submission, polling and every query.

## Licence

MIT. Not affiliated with NAV.
