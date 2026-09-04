# @open-nav/cli

Command line access to the NAV **Online Számla** invoice service.

```sh
npx @open-nav/cli --help
# or
npm install -g @open-nav/cli && open-nav --help
```

## Configuration

Credentials come from the environment, or from a `.env` file found by walking
up from the working directory. They are **never** accepted as command line
arguments: that would put them in shell history, in process listings, and in
the transcript of any agent that ran the command.

```sh
cp .env.example .env   # then fill it in
open-nav config        # shows what is set, masks the secrets
open-nav token         # end-to-end check: are the credentials real?
```

`open-nav help config` lists every variable.

## Built for scripts and agents

- **JSON by default when stdout is not a terminal.** No flag to remember; a
  human at a terminal still gets readable text. `--json` and `--pretty`
  override.
- **One envelope for every result**, so a caller can branch on `ok` alone:
  ```json
  { "ok": true, "command": "validate", "data": { "valid": true } }
  ```
- **Exit codes that mean something**: `0` ok, `2` usage or configuration, `3`
  the document failed local validation and was not sent, `4` NAV rejected it,
  `5` no verdict reached (network, timeout, still processing).
- **`--describe`** prints the whole command surface as JSON — names, usage,
  options, exit codes, and whether each command needs credentials. An agent
  can discover what the tool can do without a man page.

```sh
open-nav --describe | jq '.commands[] | select(.needsCredentials == false)'
```

## Commands

| Command                    | Needs credentials | What it does                                               |
| -------------------------- | ----------------- | ---------------------------------------------------------- |
| `config`                   | no                | Report which variables are set, masking secrets            |
| `validate <file>`          | no                | Check an invoice against schema and business rules         |
| `fault <CODE>`             | no                | Look up NAV's description of a fault code                  |
| `token`                    | yes               | Exchange credentials for a token — the quickest smoke test |
| `taxpayer <taxNumber>`     | yes               | Look up a taxpayer; accepts the 11 digit written form      |
| `submit <file...>`         | yes               | Validate, then submit; `--wait` polls for the verdict      |
| `status <transactionId>`   | yes               | Processing status; `--wait` polls to a verdict             |
| `digest --from --to`       | yes               | List invoices issued or received in a date range           |
| `invoice <number>`         | yes               | Fetch one invoice in full; `--xml` prints the XML          |
| `transactions --from --to` | yes               | List data submissions in a time window                     |

## Validating without credentials

`validate` and `fault` contact nothing. They are useful before you have a
technical user at all, and they are the fastest way to find out why NAV
rejected something:

```sh
open-nav validate invoice.xml --operation CREATE --pretty
```

```text
invoice.xml: invalid (1 error, 0 warnings)

  error  INCORRECT_SUMMARY_CALCULATION_INVOICE_VAT_AMOUNT_SUMMARY
         invoiceSummary.summaryNormal.invoiceVatAmount
         is 280000.00 but the lines total 280800.00
         NAV: The amount of the tax VAT rates differs from the VAT of the invoice.
```

Findings carry NAV's own fault code and wording, in `en`, `hu` or `de` via
`--language`, so a local failure reads like the rejection it prevents.

`submit` validates before sending by default and refuses to submit a document
with errors — a rejection costs a round trip and consumes the `requestId`.
`--skip-validation` overrides that if you need it.

## Licence

MIT. Not affiliated with NAV.
