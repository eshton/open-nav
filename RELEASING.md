# Releasing

Six packages go to npm under the `@open-nav` scope, in lockstep, from a tag.

| Package                 | What a consumer gets                     |
| ----------------------- | ---------------------------------------- |
| `@open-nav/core`        | Types, crypto, XML, decimals, validation |
| `@open-nav/client`      | The API client and bulk download         |
| `@open-nav/invoicing`   | Printable documents and the NGM export   |
| `@open-nav/mock-server` | A local stand-in for the service         |
| `@open-nav/cli`         | The `open-nav` command                   |
| `@open-nav/mcp`         | The `open-nav-mcp` MCP server            |

`@open-nav/codegen` stays private: it is a build tool for this repository, and
publishing it would invite people to depend on it.

## One-time setup

1. **Create the `open-nav` organisation on npmjs.com.** The scope has to exist
   before anything can be published into it, and only a human with the account
   can create it. A free org publishes public packages at no cost.
2. **First publish uses a token.** Create an automation access token on
   npmjs.com and store it as the `NPM_TOKEN` repository secret. Trusted
   publishing cannot be configured for a package that does not exist yet.
3. **Then switch to trusted publishing.** For each of the six packages, on
   npmjs.com → package → Settings → Trusted publisher, point it at this
   repository and `.github/workflows/release.yml`. After that the `NPM_TOKEN`
   secret can be deleted: the workflow's OIDC token is enough, and there is no
   long-lived credential left to leak.

## Cutting a release

```sh
pnpm version:set 0.2.0        # every manifest, in lockstep
pnpm verify                   # format, licences, typecheck, tests, tarballs
git commit -am 'Release 0.2.0'
git tag v0.2.0
git push origin main --follow-tags
```

The tag is the trigger. The workflow re-runs `pnpm verify` and
`pnpm codegen:check`, refuses to continue if the tag does not match the
version in `package.json`, and publishes with provenance.

A version with a prerelease part (`0.2.0-rc.1`) is published under the `next`
dist-tag, so `npm install @open-nav/core` never picks it up.

To rehearse without publishing, run the workflow manually from the Actions
tab: `dry-run` defaults to true.

### Nothing else needs editing on release day

`pnpm version:set` writes the seven manifests and stops. There is no version
string anywhere else: the CLI's `--version` and the MCP server's advertised
version both read their own `package.json` at runtime, and the packages depend
on each other with `workspace:^`, which carries no version in the repository
at all. That is the reason for lockstep versioning — a bump can never leave a
package pointing at a sibling version that was never published.

## Publishing by hand

Same code path as the workflow, minus provenance (which needs a CI runner):

```sh
npm login
pnpm publish:packages --dry-run   # prints exactly what would be sent
pnpm publish:packages
```

## How the publish actually works, and why it is two tools

`scripts/publish-packages.mjs` runs `pnpm pack` and then
`npm publish <tarball>`, because neither tool can do the whole job:

- Only **`pnpm pack`** rewrites `workspace:^` into a real semver range.
  `npm publish` would send that protocol string verbatim and produce a
  manifest nobody can install.
- Only **`npm publish`** implements provenance attestation and npm's trusted
  publishing.

Publishing the tarball gets both, and publishes byte for byte the artifact
that `pnpm check:packages` validated.

Packages go out in dependency order — core, client, invoicing, mock-server,
cli, mcp — so that someone installing `@open-nav/client` the moment it appears
can already resolve the `@open-nav/core` it asks for.

## What is checked before anything is sent

`pnpm check:packages` packs every package and inspects the **tarballs**, not
the source tree. `files`, the export maps and the `workspace:` rewriting only
take effect at pack time, so every mistake worth catching is invisible
earlier.

- **`publint`** — the manifest against how Node and bundlers resolve it.
- **`attw`** — that the types resolve under each module resolution mode.
  `cjs-resolves-to-esm` is ignored on purpose: these packages are ESM-only,
  so that rule would just report the decision back to us on every run.

`pnpm licences` is the other publish-specific check. npm only packs files from
inside a package directory, so the repository root `LICENSE` would never reach
a consumer; each package carries its own copy, and this asserts the copies have
not drifted (`pnpm licences:fix` re-copies them).

## Deliberate choices

**ESM-only.** Everything is `"type": "module"` with Node 20.10 as the floor.
A CommonJS consumer needs `await import(...)`. Dual publishing would double the
build and the test surface for a shrinking audience.

**`src` ships alongside `dist`.** The declaration maps and source maps point at
it, so stepping into this code in a debugger lands in the real source rather
than in generated JavaScript — and the source carries most of the reasoning
about NAV's rules.

**Provenance lives in CI, not `.npmrc`.** It requires an OIDC-capable runner,
and `provenance=true` in `.npmrc` makes a publish from a laptop fail outright.
The workflow sets `NPM_CONFIG_PROVENANCE=true` instead.

## Unpublishing

npm allows it for 72 hours, and it breaks anyone who already installed the
version. Publish a patch instead. `npm deprecate` is the right tool for a
version that should not be used:

```sh
npm deprecate @open-nav/core@0.2.0 "Broken summary rounding; use 0.2.1"
```
