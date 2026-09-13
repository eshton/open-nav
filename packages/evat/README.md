# @open-nav/evat

Generated TypeScript types and schema metadata for NAV's **eÁFA (eVAT)** M2M
interface — the electronic VAT-return system, distinct from Online Számla.

**Private / work in progress.** This package currently ships only the generated
types and serialisation metadata (from the vendored `schemas/EAR/2.0/` XSDs, see
`scripts/vendor_schemas.py`). The client, validator and mock are tracked in the
open-evat backlog (EVAT-3…10).

> The eVAT schemas are vendored under NAV's evident org-wide MIT intent; the
> upstream repository states no licence. See `schemas/NOTICE.md`.
