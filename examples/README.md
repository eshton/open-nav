# Examples

Runnable, end-to-end walkthroughs of the library. Not published to npm.

## `report-invoice.mjs`

The whole round trip: validate an invoice locally, report it to NAV, poll for
the per-invoice verdict, and render the printable PDF.

```sh
# from the repo root, after `pnpm install && pnpm build`
node examples/report-invoice.mjs
# or
pnpm --filter @open-nav/examples report
```

With no credentials it runs against the bundled mock service, so it works out
of the box — and it runs in CI as an integration smoke test across
`@open-nav/core`, `@open-nav/client`, `@open-nav/invoicing` and
`@open-nav/mock-server`.

### Pointing it at NAV's test system

Set the technical user's credentials in the environment and it talks to the
real service instead of the mock:

```sh
export NAV_LOGIN=...
export NAV_PASSWORD=...
export NAV_SIGN_KEY=...
export NAV_EXCHANGE_KEY=...
export NAV_TAX_NUMBER=12345678   # the 8-digit core, optional; defaults to the invoice's supplier
node examples/report-invoice.mjs
```

Credentials are read from the environment only — never passed as arguments,
which would put them in shell history.
