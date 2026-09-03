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
   its forint twin, and being one forint out means the whole batch is
   rejected. The rules are not plain summation either: when a line omits its
   VAT amount, the figure has to be derived from the rate, and a VAT
   exemption is identified by its legal case and not by the free text beside
   it. Six of NAV's own thirty sample invoices get their totals wrong.

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

| Path               | What it is                                                             |
| ------------------ | ---------------------------------------------------------------------- |
| `packages/core`    | Types, crypto, XML, payload encoding, exact decimals, validation       |
| `packages/client`  | Client for all ten service operations, plus transaction polling        |
| `packages/cli`     | `open-nav` command line tool, built for scripts and agents             |
| `packages/codegen` | Generates the types, schema metadata and fault catalogue from the XSDs |
| `schemas/`         | Official NAV XSDs and message catalogues, vendored verbatim            |
| `conformance/`     | NAV's own 41 sample documents, used as the golden test corpus          |
| `scripts/`         | Schema vendoring and drift detection                                   |

Still to come: a local mock of the invoice service, and invoice document
generation with the 23/2014. (VI. 30.) NGM data export. Neither is stubbed out
in advance.

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

| Area                           | State                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Cryptographic primitives       | Verified against published SHA-512 and SHA3-512 vectors                                                                    |
| Request signature construction | Verified against all 11 of NAV's official request samples, including the three-invoice batch                               |
| Schema round trip              | Verified against all 41 official NAV sample documents                                                                      |
| Schema validation              | Accepts all 41 official documents; every facet kind covered by tests                                                       |
| Business rules                 | 24 of NAV's 30 sample invoices pass with no findings; the other 6 raise only the arithmetic faults that are wrong upstream |
| Summary reconciliation         | Reproduces the summaries of those same 24 samples                                                                          |
| Client request building        | Verified by recomputing each signature from the request actually sent                                                      |
| Exchange token decryption      | Round-trip tested for padded and unpadded tokens; no official vector exists                                                |
| Live NAV test system           | **Not yet exercised** — no technical user credentials                                                                      |

## Validating before you send

Local validation is the point of the library, not a sideline. Two layers run:
the schema, generated from NAV's XSDs, and the business rules that are
decidable from the document alone.

```ts
import { validateInvoice } from '@open-nav/core';

const report = validateInvoice(invoice, { operation: 'CREATE' });
if (!report.valid) {
  for (const issue of report.errors) {
    console.error(issue.code, issue.path, issue.message, issue.navMessage);
  }
}
```

Every finding carries **NAV's own fault code**, taken from the error catalogue
NAV publishes and generated into a typed union of all 236 codes with their
Hungarian, English and German wording. A rule cannot cite a code NAV does not
define, and a local failure reads like the rejection it prevents. The handful
of findings we raise that NAV has no code for are marked `origin: 'local'`
rather than squeezed into an approximate one.

Errors and warnings are kept apart deliberately. A tax number that fails its
check digit is a **warning**: NAV validates tax numbers against its taxpayer
registry, not arithmetically, and two of the four tax numbers in its own
samples fail the check. Treating that as an error would reject documents the
service accepts — and a validator that flags valid documents gets switched
off. `queryTaxpayer` is the authority.

## Command line

```sh
npx @open-nav/cli --help
```

Configuration comes from the environment or a `.env` file (see
[.env.example](.env.example)); credentials are never taken as arguments,
because that would put them in shell history and in agent transcripts.

```sh
cp .env.example .env
open-nav config     # what is set, secrets masked
open-nav token      # are the credentials real?
open-nav validate invoice.xml --pretty
open-nav submit invoice.xml --wait
```

It is built to be driven by a program as much as by a person: JSON output
whenever stdout is not a terminal, one envelope for every result, meaningful
exit codes (`3` invalid document, `4` rejected by NAV, `5` no verdict), and
`--describe` to emit the whole command surface as JSON so a caller can
discover it. `validate` and `fault` need no credentials at all. See
[packages/cli/README.md](packages/cli/README.md).

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
