# @open-nav/receipt

Generated TypeScript types and schema metadata for NAV's **eNyugta** (eReceipt /
e-cash-register, ePénztárgép) M2M interface — a separate NAV data service, not
Online Számla and not the printable receipt renderer in `@open-nav/invoicing`.

**Private / work in progress.** Currently only the generated types and
serialisation metadata (from the vendored `schemas/ERECEIPT/1.1/` XSDs, see
`scripts/vendor_schemas.py`). The client, validator and mock are tracked in
ONAV-37 and the related backlog.

> The eReceipt schemas are vendored under NAV's evident org-wide MIT intent; the
> upstream repository states no licence. See `schemas/NOTICE.md`.
