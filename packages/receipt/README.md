# @open-nav/receipt

Client and cryptography for NAV's **eNyugta** (eReceipt / e-cash-register,
_ePénztárgép_) M2M interface — a separate NAV data service, not Online Számla
and not the printable receipt renderer in `@open-nav/invoicing`.

```sh
npm install @open-nav/receipt
```

Generated types and serialisation metadata come from the vendored
`schemas/ERECEIPT/1.1/` XSDs (see `scripts/vendor_schemas.py`); the schemas are
vendored under NAV's evident org-wide MIT intent, though the upstream repository
states no licence (see `schemas/NOTICE.md`).

> **Private / work in progress.** The endpoints are pinned from NAV's apidog
> collection (the **hardware** e-cash-register interface): the test ("BV") hosts
> are `navi-bv.enyugta.nav.gov.hu` (registration, unsecured) and
> `navi-bv-sec.enyugta.nav.gov.hu` (data services, mutual TLS); production drops
> the `-bv` suffix (to confirm on the live system). Everything here is still
> unverified against a live register — that needs an e-cash-register AP number —
> and the customer-key ECC wrapping is still open (ONAV-37 backlog). The cloud
> (FAM) register at `fam.enyugta.nav.gov.hu` is a separate REST API, not this
> XML/XSD interface.

## The two phases

An e-cash register is **certificate-authenticated**, not technical-user
authenticated like Online Számla. So there are two clients:

1. `ReceiptRegistrationClient` — the unauthenticated **bootstrap**: register the
   device, obtain the authentication + signing certificates.
2. `ReceiptClient` — the **authenticated data services**, over mutual TLS with
   the authentication certificate: `hello`, `cashRegisterInfo`, document/report
   submission, and the read-only queries.

## Registration (bootstrap)

```ts
import { ReceiptRegistrationClient } from '@open-nav/receipt';

const registration = new ReceiptRegistrationClient({
  software: {
    softwareId: '12345678SZAMLAL01',
    softwareName: 'my e-cash register',
    softwareOperation: 'LOCAL_SOFTWARE',
    softwareMainVersion: '1.0.0',
    softwareDevName: 'My Company',
    softwareDevContact: 'dev@example.com',
    softwareDevCountryCode: 'HU',
    softwareDevTaxNumber: '12345678',
    softwareHash: '…',
    softwareLastUpdateTime: '2026-01-01T00:00:00Z',
  },
  baseUrl: 'https://navi-bv.enyugta.nav.gov.hu/eReceiptMgmt/v1', // test (BV) registration host
});

const { response, authentication, signing } = await registration.register({
  apNumber: 'AP12345678',
  registrationNumber: 'INSTALL-CODE', // the code the taxpayer got from NAV
  imei: '350000000000001',
  imsi: '216300000000001',
});
```

When you do not pass CSRs, the client **generates the authentication and signing
RSA key pairs and CSRs for you** and returns them — store the private keys
securely (a hardware register keeps them in a hardware key store). CSRs are sent
as base64 DER, not PEM: PEM's whitespace does not survive the XML round trip.

The response carries the certificate-download endpoints; fetch each certificate
(the spec asks the register to wait 5 seconds first):

```ts
const authCert = await registration.downloadCertificate(endpointUrl); // waits 5s
```

`renewCertificate()` covers certificate rotation before expiry.

## Submitting receipts and reports

```ts
import { ReceiptClient } from '@open-nav/receipt';

const client = new ReceiptClient({
  apNumber: 'AP12345678',
  clientCertificate: { cert: authCertPem, key: authKeyPem }, // mutual TLS
  baseUrl: 'https://navi-bv-sec.enyugta.nav.gov.hu', // test (BV) secured data host
});

await client.hello({ currentOperatorSiteProcessId: operatorSiteProcessId });

const outcome = await client.submitDocument({
  taxNumber: '12345678',
  documentClass: 'RECEIPT',
  searchKey: 'SK-…',
  searchKeyTimestamp: '2026-05-15T09:59:00Z',
  recordCounter: 2,
  lastRecordCounter: 1,
  ntcaVerificationCode: '…',
  qRCodeExpired: false,
  offlineCreated: false,
  cashRegisterSignCertificate: signCertDerBase64,
  coreDocumentXml, // serialized CoreDocument (NAV + issuer data)
  customerDocumentXml, // serialized CustomerDocument (customer copy)
  signingKeyPem, // the register's signing private key
});
```

`submitDocument` / `submitReport` do the work worth having a library for: they
build the **signed envelope** the service requires. For each payload —
canonicalise (RFC 3076) → gzip → AES-256-CBC (one fresh key per envelope) →
base64 — then RSA-SHA256 sign the concatenated `envelopeData +
customerEnvelopeData` with the signing key. The single `decryptKey` and the
`envelopeHash` / `envelopeSignature` are placed on the request for you.

The envelope primitives are exported directly if you need them —
`buildDocumentEnvelope`, `buildReportEnvelope`, `openEnvelope` (the inverse, for
reading received reports) and `verifyEnvelopeSignature`.

## Queries

```ts
const taxpayer = await client.queryTaxpayer('12345678');
const product = await client.getProductByCode('01012100');
```

## Transport

`postReceiptXml` is the unauthenticated bootstrap layer; `postReceiptXmlSecure`
is the authenticated one — it presents the register's client certificate over
Node's TLS stack, unless you inject a custom `fetch` (a test stub, or a runtime
that manages the certificate itself). NAV's error verdict (`funcCode === ERROR`)
becomes a `NavApiError` carrying the fault code, so it reads as itself rather
than as an opaque HTTP status.

## Customer receipt (ECIES)

Separate from the NAV submission: the customer's own copy of the receipt is
encrypted to the customer's SECP256R1 public key (presented via QR) so only they
can read it (§4.5). `encryptCustomerReceipt` runs the ECIES flow (ECDH → KDF2
SHA-256 → AES-256-CBC → HMAC-SHA-256, compressed keys); `decryptCustomerReceipt`
is the customer-app side.

```ts
import { encryptCustomerReceipt, decryptCustomerReceipt } from '@open-nav/receipt';

const sealed = encryptCustomerReceipt(receiptXml, customerCompressedPublicKey);
// … customer side …
const xml = decryptCustomerReceipt(sealed, customerPrivateKey);
```

> Verified only by an in-process round trip — the KDF2 key-split order and MAC
> encoding cannot be pinned to NAV's reference without an official test vector.

## Testing without certificates

`createReceiptMock()` returns a `fetch` to hand to either client via
`transport.fetch`, so the whole lifecycle — register → download certificate →
hello → submit document/report → query — runs in-process with no certificate and
no live NAV access. It validates that submissions carry a well-formed signed
envelope. This is what downstream consumers should test against.

```ts
import { createReceiptMock, ReceiptClient } from '@open-nav/receipt';

const mock = createReceiptMock();
const client = new ReceiptClient({ apNumber: 'AP12345678', transport: { fetch: mock.fetch } });
```

## Licence

MIT. Not affiliated with NAV.
