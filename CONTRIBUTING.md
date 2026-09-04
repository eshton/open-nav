# Contributing

Thanks for considering it. This project is most useful if the people who hit
NAV's sharp edges in production write down what they found.

## Ground rules

**Never commit credentials.** No technical user login, password, exchange key
or signature key, in code, tests, fixtures or issue reports. If you paste a
request into an issue, redact `login`, `passwordHash` and `requestSignature`.

**Never hand-edit `schemas/` or `conformance/`.** Those files are vendored
verbatim from NAV and their checksums are recorded in `schemas/sources.json`.
Refresh them with `python3 scripts/vendor_schemas.py` and commit the diff on
its own, so a schema change is never mixed into a behavioural change.

**Do not hand-write generated code.** Types and schema metadata are derived
from the XSDs. Change the generator, not its output.

## Getting set up

```sh
pnpm install
pnpm verify        # format, licences, typecheck, tests, tarballs — what CI runs
pnpm test:watch
```

`pnpm verify` ends by packing every package and inspecting the tarballs, which
is slower than the rest put together but catches the class of mistake that is
invisible in the source tree. `pnpm test` alone is the fast loop.

Releases are cut from a tag by a maintainer — see [RELEASING.md](RELEASING.md).
Nothing in a pull request should touch a version number.

## What makes a good pull request

- A test that fails before your change. For anything schema-related, prefer a
  fixture in `conformance/` over a hand-rolled XML string — if NAV publishes a
  sample that covers your case, that sample is the better test.
- NAV's error code in the commit message when you are fixing a rejection, so
  the next person searching for `INVALID_CUSTOMER_VAT_STATUS` finds it.
- Bilingual naming left alone: element and enum names come from the schema and
  stay exactly as NAV spells them, even where the English is awkward.

## Reporting a NAV rejection

The most valuable issues include:

1. The operation (`manageInvoice`, `queryInvoiceDigest`, …).
2. NAV's `funcCode` and `errorCode`, plus any validation messages verbatim.
3. The request that caused it, credentials redacted.
4. Whether it came from the test or production system — they do diverge.

## Legal boundary

This project provides primitives. It does not certify anyone's invoicing
program and cannot discharge obligations under the VAT Act or decree
23/2014. (VI. 30.) NGM. Please do not file issues asking the maintainers to
confirm that a given setup is compliant; that is a question for your
accountant or the tax authority.
