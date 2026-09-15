# eNyugta / ePénztárgép — how it works, the timeline, and the opportunity

Background notes for `@open-nav/receipt` (the eNyugta M2M client): what the system
is, the regulatory deadlines driving adoption, and where a product built on this
library fits. Not legal advice — dates are from NAV/NGM sources current to
September 2026; verify against NAV before acting.

## What it is

eNyugta is Hungary's **e-receipt / e-cash-register (ePénztárgép)** system — the
successor to the online cash registers. It is the **retail / B2C** channel
(receipts, _nyugta_), distinct from Online Számla (B2B invoices).

- **Seller** — the taxpayer running an e-cash register. Issues receipts and
  reports the data to NAV. This is the side `@open-nav/receipt` implements.
- **Customer / buyer** — the consumer. Can receive a **digital receipt** on their
  phone instead of (or alongside) paper.

Two kinds of register:

- **Hardware** register (a device / Tax Unit "AE") — the XML/XSD M2M interface
  `@open-nav/receipt` targets.
- **Cloud** register (software, via NAV's FAM module) — a separate REST/JSON API.

## How a sale flows

1. Sell something → the register builds the receipt: `CoreDocument` (NAV + issuer
   data) and `CustomerDocument` (the buyer's copy).
2. The register **signs + encrypts** it into the envelope — C14N (RFC 3076) →
   gzip → AES-256-CBC → RSA-SHA256 signature — and **submits** it to NAV over
   **mutual TLS** (`submitDocument`). Periodic **reports** go the same way
   (`submitReport`).
3. NAV stores it. The buyer can later retrieve **their** copy.

### The AP number and PKI

The **AP number** is the unique id of a specific e-cash-register unit, assigned
by the manufacturer/distributor and registered to the taxpayer with NAV. It is a
**device id**, not the taxpayer's tax number, and it rides every request
(`APNumber`). It is backed by a **PKI enrolment**:

- The device **registers** (`registration`): sends its AP number + install code +
  CSRs.
- NAV issues two **X.509 certificates** (authentication + signing).
- Every submission is then **signed** with the signing cert and sent over
  **mutual TLS** with the authentication cert. The AP number identifies the unit;
  the certs prove it.

### Buyer retrieval is anonymous (bearer + key)

NAV does not know who the buyer is. Retrieval is **token/key based**, not
identity based:

- Each receipt carries a **`searchKey`** (+ timestamp). The receipt store is
  queried by that token, which the buyer gets from the **QR code** on the receipt
  — a claim-ticket lookup, no login.
- If the buyer presented their **SECP256R1 public key** at checkout (via an
  e-nyugta wallet app's QR), their copy is **ECIES-encrypted to that key**; only
  their private key can read it (`decryptCustomerReceipt`). NAV only ever saw a
  throwaway public key.

So the buyer's flow is: buy → get QR (search key) → later, the wallet app pulls
the receipt from NAV's store by that key and decrypts it. Old online-cash-register
slips have only a barcode (a seller-side id), not this retrieval QR.

## Regulatory timeline (8/2025. NGM rendelet)

| Date           | What                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| 2025-07-01     | eNyugta / ePénztárgép **voluntary**; NAV's free app available                                |
| **2026-09-01** | **Mandatory** e-receipt data reporting for businesses that used **manual/computer receipts** |
| 2026-12-31     | Last date to **commission a new** traditional online cash register                           |
| **2028-07-01** | Online cash registers **phased out** — all sellers on an e-cash register                     |

Two markets fall out:

- **Segment A (urgent)** — businesses that gave paper/handwritten receipts (were
  _not_ on online cash registers): mandatory since **2026-09-01**, so many are
  non-compliant now. Non-technical, deadline-driven.
- **Segment B (large, slower)** — existing online-cash-register users: must switch
  by **2028-07-01**. Huge volume, long runway.

## Cheaper / better (the carrot)

- NAV's own **ePénztárgép + eNyugta app is free**; runs on a phone/tablet,
  cloud-based, no dedicated hardware, no annual AEE servicing fee.
- Digital, searchable receipts for buyers; less paper.

## The opportunity, and where this library fits

Because NAV gives away a free app, the value is in what that generic app does not
do:

1. **Integration** — embed e-cash-register/eNyugta into existing POS / ERP /
   webshop / booking / invoicing software over the M2M interface. **This is what
   `@open-nav/receipt` is for.**
2. **Verticals** — restaurant / salon / pharmacy tills with the e-receipt built in.
3. **Multi-site / chains** — central management, many tills, reporting.
4. **Onboarding + support** — setup/migration/hand-holding for Segment A.
5. **Hardware bundles** — tablet + printer + software.
6. **Certified e-cash-register vendor** — the moat: register with NAV's e-cash
   register **developer/manufacturer programme**, get certified, and NAV issues
   **AP numbers** for your product. Then you _are_ an ePénztárgép provider.

`@open-nav/receipt` is the seller-side engine (issue → sign → encrypt → submit)
for options 1–3 and 6; `decryptCustomerReceipt` is the buyer-app half for a
wallet/loyalty angle. It is built and unit-tested. Going live needs the
manufacturer enrolment + a (test) AP number — the same gate any real e-cash
register vendor must clear, so it is the price of entry, not extra cost. See the
`@open-nav/receipt` README and ONAV-37.

## Sources

- Kötelező nyugtaadat-szolgáltatás 2026. szeptember 1-től — PBKIK: https://pbkik.hu/2026/07/14/hirek/kotelezo-nyugtaadat-szolgaltatas-2026-szeptember-1-tol-enyugta-epenztargep/
- NAV — e-pénztárgép-használat, adatszolgáltatás: https://nav.gov.hu/ado/enyugta/kerdesek-es-valaszok/e-penztargep-hasznalat-adatszolgaltatas
- E-pénztárgép, e-nyugta — 8/2025. NGM rendelet: https://e-penztargep.info/
- Nyugta-adatszolgáltatás — 5percadó: https://5percado.hu/nyugta-adatszolgaltatas-szeptember-1-jetol-nem-az-e-penztargep-a-kotelezo-hanem-az-adat-dr-sztanko-daniel/
- NAV eRECEIPT dev docs (§4.5 crypto, etc.): https://github.com/nav-gov-hu/eRECEIPT
