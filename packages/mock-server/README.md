# @open-nav/mock-server

A local stand-in for the NAV **Online Számla** invoice service, so an
integration can be tested without a technical user.

```sh
npx @open-nav/mock-server
```

It prints a set of fake credentials and a base URL. Export them and the
`open-nav` CLI — or your own code — talks to the mock exactly as it would to
NAV.

## Why not just stub `fetch`

Because the parts that break are the parts a stub skips. This mock:

- **Verifies the request signature the way NAV does**, recomputing the
  SHA3-512 of `requestId + timestamp + signKey`, plus the concatenated
  per-operation hashes in index order for a batch. A caller that builds the
  signature wrongly finds out here, against a readable error, instead of
  against the live service where the only clue is `INVALID_SIGNATURE`.
- **Rejects a replayed `requestId`**, which is how a home-made identifier
  scheme fails in production.
- **Spends an exchange token exactly once.**
- **Decides an invoice's fate with this project's validator**, so a broken
  invoice comes back `ABORTED` carrying the same NAV fault code the service
  would have reported.
- Keeps the invoices, so `queryInvoiceDigest`, `queryInvoiceData` and
  `queryInvoiceCheck` answer from what was actually submitted.

## In tests

```ts
import { startMockServer } from '@open-nav/mock-server';
import { NavClient, waitForTransaction } from '@open-nav/client';

const mock = await startMockServer({ credentials, pollsBeforeDone: 2 });
const client = new NavClient({ credentials, software, baseUrl: mock.url });

const { transactionId } = await client.submitInvoices([{ operation: 'CREATE', invoice }]);
const outcome = await waitForTransaction(client, transactionId);

expect(outcome.accepted).toHaveLength(1);
expect(mock.state.invoices.size).toBe(1); // assert on what the service received
await mock.close();
```

`pollsBeforeDone` controls how many polls a transaction takes to settle, so a
caller's polling loop can be exercised deliberately: it walks `RECEIVED` →
`PROCESSING` → `DONE` rather than settling immediately.

`mock.state` exposes everything received — invoices, transactions, issued
tokens, and the raw body of every request — so a test can assert on what was
sent, not only on what came back.

## Options

| Option            | Default             | Meaning                                         |
| ----------------- | ------------------- | ----------------------------------------------- |
| `credentials`     | —                   | The technical user the mock accepts             |
| `taxpayers`       | `[]`                | Registry `queryTaxpayer` answers from           |
| `port`            | `0` (any free port) | `8080` when run from the CLI                    |
| `pollsBeforeDone` | `0`                 | Polls before a transaction settles              |
| `validate`        | `true`              | Abort invoices this project's validator rejects |
| `now`             | `() => new Date()`  | Injectable clock                                |

## What it is not

Not a reimplementation of NAV. It does not know your invoice history, will not
tell you whether an invoice number was used two years ago, and its acceptance
is not evidence that NAV will accept the same document. It exists to catch the
mistakes that are decidable locally, early and cheaply.

## Licence

MIT. Not affiliated with NAV.
