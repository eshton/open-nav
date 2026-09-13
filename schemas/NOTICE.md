# Vendored schema provenance and licence notice

The XML schemas under `schemas/` are copied verbatim from the Hungarian Tax
Authority's (NAV) public GitHub repositories by `scripts/vendor_schemas.py`.
Exact source repository, revision and per-file SHA-256 are recorded in
`schemas/sources.json`.

## Licensed sources (MIT)

- **Online Számla (OSA 3.0)** — [`nav-gov-hu/Online-Invoice`](https://github.com/nav-gov-hu/Online-Invoice)
- **NTCA common** — [`nav-gov-hu/Common`](https://github.com/nav-gov-hu/Common)

Both ship an explicit `LICENCE.md` — the **MIT Licence, Copyright (c) Nemzeti
Adó- és Vámhivatal** — reproduced in `schemas/NAV-LICENCE.md`. These files are
redistributed here under that grant.

## Sources with no stated licence

- **eÁFA / eVAT (EAR 2.0)** — [`nav-gov-hu/eVAT`](https://github.com/nav-gov-hu/eVAT)
- **eNyugta / eReceipt (ERECEIPT 1.1)** — [`nav-gov-hu/eRECEIPT`](https://github.com/nav-gov-hu/eRECEIPT)

**These two repositories contain no licence file.** NAV publishes them so
developers can integrate with the eÁFA and eNyugta machine-to-machine
interfaces; using the schemas to build and validate messages is plainly their
intended purpose. Redistributing the files — which is what vendoring them into
this repository does — is a separate act that an explicit licence would
normally govern.

We include them here on the basis that **NAV's evident intent is MIT**:

- the organisation-wide default licence, [`nav-gov-hu/.github`](https://github.com/nav-gov-hu/.github),
  is the MIT Licence, Copyright (c) 2025 NAV;
- NAV's sibling schema repositories (`Common`, `Online-Invoice`) are all MIT;
- the eVAT/eReceipt schema files use the same header format and authorship
  ("NAV Informatikai Intézet") as the MIT-licensed OSA schemas.

This is an inference about intent, **not an explicit grant**. Schema/interface
definitions are also, in substance, largely factual descriptions of a data
format. We have asked NAV to add a licence to these repositories; if they
decline, or ask us not to redistribute the files, the affected sources will be
removed from `scripts/vendor_schemas.py` and from `schemas/`.

No NAV file in this repository has been modified. All copyright in the vendored
schemas remains with the Nemzeti Adó- és Vámhivatal. open-nav's own MIT licence
covers open-nav's code, not these third-party schema files.
