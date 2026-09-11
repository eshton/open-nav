# CLAUDE.md

Guidance for AI agents working in this repo. See `README.md` for the project
overview and `CONTRIBUTING.md` for the human-facing version of these rules.

## What this is

Open-source TypeScript libraries for the Hungarian Tax Authority (NAV) Online
Számla API: building schema-valid invoice data, reporting it, querying it,
rendering documents. pnpm workspace monorepo. **ESM-only**, Node.js >= 20.10.

## Commands

```sh
pnpm install
pnpm verify        # what CI runs: format:check, licences, typecheck, test, packaged tarballs
pnpm test          # fast loop (vitest run)
pnpm test:watch
pnpm typecheck     # tsc -b --force across all packages
pnpm format        # prettier --write .
pnpm codegen       # regenerate packages/core/src/generated from the XSDs
pnpm build         # tsc -b all packages
```

Run a single package's tests: `pnpm --filter @open-nav/core exec vitest run <path>`.

## Hard rules — do not violate

- **Never hand-edit `packages/core/src/generated/`** (`types.ts`, `schema.ts`,
  `fault-codes.ts`). Generated from the NAV XSDs. Change `packages/codegen`,
  then run `pnpm codegen`. `pnpm codegen:check` must stay green.
- **Never hand-edit `schemas/` or `conformance/`.** Vendored verbatim from NAV,
  checksums recorded in `schemas/sources.json`. Refresh via
  `python3 scripts/vendor_schemas.py` in its own commit.
- **Never commit credentials** — login, password, exchange key, sign key — in
  code, tests, or fixtures.
- **Never touch version numbers** in a PR. Releases are cut from a tag.

## Package layout

| Package                | What it is                                                             |
| ---------------------- | ---------------------------------------------------------------------- |
| `packages/core`        | Types, crypto, XML, decimals, validation. Depends on nothing internal. |
| `packages/client`      | HTTP client for the ten service operations + polling                   |
| `packages/invoicing`   | Printable PDF/HTML documents + NGM data export                         |
| `packages/mock-server` | Local stand-in for the NAV service (tests, no creds)                   |
| `packages/cli`         | `open-nav` command line tool                                           |
| `packages/mcp`         | MCP server                                                             |
| `packages/codegen`     | Generates core's types/schema/faults from the XSDs                     |

Dependency direction: everything depends on `core`; `cli`/`mcp` depend on
`core` + `client` + `invoicing`. Keep it acyclic.

## Conventions

- Prettier enforced: single quotes, semicolons, `printWidth` 100,
  `trailingComma: all`. Run `pnpm format` before finishing.
- Tests live in `packages/*/test/`, vitest.
- Prefer a fixture from `conformance/` (NAV's own samples) over a hand-rolled
  XML string when testing schema behaviour.
- Every validation finding must carry a real NAV fault code, or be marked
  `origin: 'local'` — never invent a code NAV does not define.
- When fixing a NAV rejection, put the NAV error code in the commit message.
