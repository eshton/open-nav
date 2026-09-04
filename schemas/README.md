# NAV schemas (vendored)

Everything in this directory is copied **verbatim** from NAV's public
repositories. Nothing here is hand-edited — if a file looks wrong, it is wrong
upstream too, and the fix belongs in an issue against NAV's repository.

| Path | Namespace | Upstream |
| --- | --- | --- |
| `OSA/3.0/invoiceApi.xsd` | `http://schemas.nav.gov.hu/OSA/3.0/api` | [Online-Invoice](https://github.com/nav-gov-hu/Online-Invoice) |
| `OSA/3.0/invoiceData.xsd` | `http://schemas.nav.gov.hu/OSA/3.0/data` | Online-Invoice |
| `OSA/3.0/invoiceBase.xsd` | `http://schemas.nav.gov.hu/OSA/3.0/base` | Online-Invoice |
| `OSA/3.0/invoiceAnnulment.xsd` | `http://schemas.nav.gov.hu/OSA/3.0/annul` | Online-Invoice |
| `OSA/3.0/serviceMetrics.xsd` | `http://schemas.nav.gov.hu/OSA/3.0/metrics` | Online-Invoice |
| `NTCA/1.0/common.xsd` | `http://schemas.nav.gov.hu/NTCA/1.0/common` | [Common](https://github.com/nav-gov-hu/Common) @ `common-1.0.0` |
| `i18n/validations_*.properties` | — | Online-Invoice (NAV validation error catalogue) |

## A note on which `common.xsd` to use

`OSA/3.0/catalog.xml` is NAV's own XML catalog, and it points `common.xsd` at
the `Common-1.0.RC3` tag. **That reference is stale**: RC3 predates
`RequestPageType` and `ResponsePageType`, which `invoiceApi.xsd` 3.0
references for its paged queries. Resolve the 3.0 API schema against RC3 and
those two types dangle.

We therefore pin `common-1.0.0`, the final NTCA 1.0 release, which defines
them. Two further traps if you go looking yourself:

* The `Common` default branch has moved on to NTCA **2.0**, which Online
  Számla 3.0 does not use.
* `Common-1.0.RC6` still has a file at the old
  `src/schemas/nav/gov/hu/NTCA/common.xsd` path, but it is **empty** — the
  schema moved to `schemas/src/main/resources/xsd/...` during a repository
  restructure. Reading the old path at that tag yields nothing, silently.

## Provenance

`sources.json` records, for every vendored file, the upstream repository, the
exact revision it came from, its upstream path and its SHA-256. That makes a
refresh reviewable: if a checksum changes, the upstream file changed.

## Refreshing

```sh
python3 scripts/vendor_schemas.py          # refresh in place, then review the diff
python3 scripts/vendor_schemas.py --check  # exit non-zero if the copy is stale
```

CI runs `--check` on a schedule, so upstream schema changes surface as a failing
build rather than as a silent divergence between this library and NAV.

## Licence

MIT, © Nemzeti Adó- és Vámhivatal — see `NAV-LICENCE.md`, reproduced from
upstream. NAV's copyright notice is retained as the licence requires.
