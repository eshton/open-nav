# open-nav

Open source libraries and tools for the Hungarian Tax and Customs
Administration's (NAV) **Online Számla** system — building invoice data that
NAV accepts, reporting it, and pulling invoices issued to you.

> **Status: early development.** The packages are not published yet and the
> API surface will change without notice. Nothing here has been exercised
> against NAV's live test system yet — see [Verification status](#verification-status).

_[Magyar összefoglaló a lap alján.](#magyarul)_

## Why

The Online Számla interface is not hard because it speaks HTTP. It is hard
because of four independent things, each of which reliably costs a day:

1. **Authentication.** A SHA-512 password hash, a SHA3-512 request signature
   computed over `requestId + timestamp + signKey` _plus a concatenation of
   per-invoice hashes_, and an exchange token that arrives AES-128-ECB
   encrypted. Get any byte wrong and NAV answers `INVALID_SIGNATURE` without
   telling you which part was wrong.
2. **The schema.** ~700 elements across four namespaces, where a tax number's
   children live in a _different_ namespace than the tax number itself, and
   where a dozen mutually exclusive choice groups decide whether your invoice
   is normal, simplified or aggregate.
3. **The asynchronous lifecycle.** `manageInvoice` returns a transaction id,
   not a result. The verdict arrives later, per invoice, split across
   _technical_ and _business_ validation messages.
4. **The arithmetic.** Line amounts must reconcile with the VAT-rate summary
   and the invoice totals, every amount on a foreign-currency invoice needs
   its forint twin, and being one forint out means the whole batch is rejected.

A library should absorb all four. That is the entire premise of this project.

## Scope

**In scope**

- Reporting: submit invoice data, poll transaction status, annul (technical
  cancellation), query outbound and inbound invoices, taxpayer lookup.
- Invoice construction: build schema-valid `InvoiceData`, with computed VAT
  summaries and exact decimal arithmetic.
- Validating locally what NAV would otherwise reject remotely.
- Producing the human-readable invoice document, and the data export required
  of invoicing programs by decree 23/2014. (VI. 30.) NGM.
- A local mock of the invoice service, so integrations can be tested without
  NAV credentials.

**Out of scope**

- Being your invoice book of record. Gapless numbering, immutable storage and
  audit trails are product concerns with legal consequences; this project
  gives you the primitives and deliberately does not claim to discharge your
  obligations.
- Other NAV systems — online cash registers, EKÁER, eÁFA/e-VAT. Different
  interfaces, different authentication. The repository layout leaves room for
  them; nothing is promised.
- Any claim of certification. "Schema-conformant and tested" is a statement
  about this code. Compliance remains yours.

## Layout

| Path            | What it is                                                    |
| --------------- | ------------------------------------------------------------- |
| `packages/core` | Types, crypto, XML, invoice model, validation                 |
| `schemas/`      | Official NAV XSDs and message catalogues, vendored verbatim   |
| `conformance/`  | NAV's own 41 sample documents, used as the golden test corpus |
| `scripts/`      | Schema vendoring and drift detection                          |
| `docs/`         | Guides                                                        |

Further packages (`cli`, `mock-server`, validation, invoice document
generation) are landing incrementally; they are not stubbed out in advance.

## Approach

**The schema is generated, not hand-written.** ~700 elements transcribed by
hand is how a project like this dies, and how it fails to survive NAV's next
interface revision. The XSDs are vendored from NAV's public repository with
recorded checksums, and the TypeScript types plus the runtime metadata that
drives serialisation, parsing and validation are generated from them. Moving
to a future 3.x is then a regeneration and a reviewable diff.

**Correctness is demonstrated against NAV's own documents.** The 41 official
samples in `conformance/` are the test corpus. Anything that fails to survive
a round trip through this library would have been rejected by NAV.

## Verification status

Being explicit, because it matters for anyone considering this in production:

| Area                           | State                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Cryptographic primitives       | Implemented; digests checked against published test vectors                                |
| Request signature construction | Implemented from the 3.0 specification, **not yet confirmed against the live test system** |
| Schema round trip              | In progress                                                                                |
| Live NAV test system           | **Not yet exercised** — no technical user credentials                                      |

## Requirements

Node.js 20.10 or newer, and pnpm 10.

```sh
pnpm install
pnpm verify    # format check, typecheck, tests
pnpm codegen   # regenerate types from the XSDs
```

## Usage sketch

The client takes each generated request type minus the header, user and
software blocks, which it builds and signs itself. There is no
hand-maintained parameter list to fall out of step with the schema.

```ts
import { NavClient, waitForTransaction } from '@open-nav/client';

const client = new NavClient({
  environment: 'test',
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

const { transactionId } = await client.submitInvoices([{ operation: 'CREATE', invoice }]);

const outcome = await waitForTransaction(client, transactionId);
console.log(outcome.accepted.length, 'stored;', outcome.rejected.length, 'rejected');
```

Note what `submitInvoices` does for you: it exchanges a token, encodes each
invoice **once** and both sends and hashes that same base64 (hashing a
separately serialised copy is a signature failure waiting to happen), and
never retries a submission that reached NAV.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports that include the NAV error
code and the (redacted) request that produced it are especially welcome — the
error catalogue in `schemas/i18n/` is only as useful as the cases we have seen.

## Licence

MIT — see [LICENSE](LICENSE). The vendored NAV schemas and samples under
`schemas/` and `conformance/` are also MIT, © Nemzeti Adó- és Vámhivatal.

This project is not affiliated with, endorsed by, or supported by NAV.

## Magyarul

Nyílt forráskódú könyvtárak és eszközök a NAV **Online Számla** rendszeréhez:
számlaadat előállítása, adatszolgáltatás beküldése, valamint kimenő és bejövő
számlák lekérdezése.

A projekt célja, hogy elvegye az interfész négy tényleges nehézségét: az
aláírásképzést, a négy névtérre szétosztott sémát, az aszinkron
tranzakciókezelést, és az összegek kerekítési és egyeztetési szabályait.

A séma nem kézzel írt: a NAV nyilvános tárolójából származó XSD fájlokból
generáljuk a típusokat, így egy későbbi interfészverzió átvezetése
újragenerálás és egy átnézhető diff.

**Jelenleg fejlesztés alatt áll**, éles használatra még nem alkalmas, és a NAV
tesztrendszerével még nem volt tesztelve. A projekt nem áll kapcsolatban a
NAV-val.
