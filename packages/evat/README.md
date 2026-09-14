# @open-nav/evat

Client for NAV's **eÁFA (eVAT)** M2M interface — Hungary's electronic
VAT-return system (EAR 2.0), distinct from Online Számla.

```sh
npm install @open-nav/evat
```

Generated types and serialisation metadata come from the vendored
`schemas/EAR/2.0/` XSDs (see `scripts/vendor_schemas.py`); the schemas are
vendored under NAV's evident org-wide MIT intent, though the upstream repository
states no licence (see `schemas/NOTICE.md`).

## Access

eÁFA reuses the **Online Számla technical user** — same login, password and
signature key, no separate credentials. Grant that technical user two things in
the NAV portals: **"Hozzáférés e-ÁFA rendszer interfészhez"** (interface access,
in the User Manager) and, for the query operations, the **"eÁFA M2M
Lekérdezés"** role. Authentication is the same crypto as Online Számla (SHA-512
password hash, SHA3-512 request signature).

```ts
import { EvatClient } from '@open-nav/evat';

const client = new EvatClient({
  environment: 'test', // or 'production'
  credentials: {
    login: process.env.NAV_LOGIN!,
    password: process.env.NAV_PASSWORD!,
    signKey: process.env.NAV_SIGN_KEY!,
    taxNumber: '12345678', // the 8-digit core
  },
  software: {
    softwareId: 'MYCOMPANY000000001',
    softwareName: 'my app',
    softwareOperation: 'LOCAL_SOFTWARE',
    softwareMainVersion: '1.0.0',
    softwareDevName: 'My Company',
    softwareDevContact: 'dev@example.com',
    softwareDevCountryCode: 'HU',
    softwareDevTaxNumber: '12345678',
  },
});
```

## Reading VAT returns

```ts
import { decodeDownloadPayload } from '@open-nav/evat';

// Discovery — find the returns filed in a window (max 35 days per query).
const list = await client.queryDeclarationList({
  taxpointDateFrom: '2026-01-01',
  taxpointDateTo: '2026-01-31',
});

// Content — download and decode a return's compiled data.
const download = await client.queryVatDeclarationData(declarationProcessingId);
const xml = decodeDownloadPayload(download.payload!); // the VatDeclarationData XML
```

The data services answer downloads as `multipart/form-data` with a gzipped
payload part; `queryVatDeclarationData`/`queryDeclarationData` return
`{ value, payload }` and `decodeDownloadPayload` gunzips the bytes. The whole
read path — discovery and content — is verified against NAV's eÁFA test system.

`queryDeclarationList` caps a query window at **35 days**. For a longer range,
`queryAllDeclarations` walks the 35-day windows for you (and `chunkTaxpointRange`
exposes the split):

```ts
import { queryAllDeclarations } from '@open-nav/evat';

const all = await queryAllDeclarations(client, {
  taxpointDateFrom: '2026-01-01',
  taxpointDateTo: '2026-12-31',
});
```

## Filing a declaration

```ts
const result = await client.submitDeclaration({
  declarationXml, // a VatDeclarationData document
  xsdVersion: 'eardata_2.0', // the current, live XSD version
  requestPeriodStart: '2026-01-01',
  requestPeriodEnd: '2026-01-31',
});
// poll queryDeclarationProcessingStatus(result.declarationProcessingId) to FINISHED,
// then manageDeclarationSubmission(...) to file.
```

`submitDeclaration` runs the upload lifecycle — `manageDeclarationUpload` (with
the SHA3-512 content hash) → gzipped `manageDeclarationPartition`(s) →
`manageDeclarationFinalize`. Polling and the final `manageDeclarationSubmission`
are separate so you control the wait and the approval. The first analytics for a
period must be **version 1**; attachment `claimCheckId`s in the XML must match
those uploaded via `manageAttachmentUpload`. This lifecycle is verified live end
to end.

`buildVatAnalytics` / `buildVatAnalyticsItem` bridge open-nav invoice data into
the declaration's VAT-analytics ledger; classifying each line to a standard tax
code is left to you (a VAT-law judgement), with `TAX_CODES` to draw on.

## Testing without credentials

`createEvatMock()` returns a `fetch` to hand to `EvatClient` via
`transport.fetch`, driving the whole lifecycle — upload, partitions, finalize,
status polling, submission and the queries — in-process with no technical user.

```ts
import { createEvatMock, EvatClient } from '@open-nav/evat';

const mock = createEvatMock({ credentials });
const client = new EvatClient({ credentials, software, transport: { fetch: mock.fetch } });
```

## Licence

MIT. Not affiliated with NAV.
