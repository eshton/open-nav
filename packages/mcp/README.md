# @open-nav/mcp

An MCP server that gives an AI agent the NAV **Online Számla** invoice
service: validate invoice data, look up a rejection, render an invoice,
report to NAV, and read back what was reported.

## Setup

```sh
claude mcp add open-nav -- npx -y @open-nav/mcp
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "open-nav": {
      "command": "npx",
      "args": ["-y", "@open-nav/mcp"],
      "env": {
        "NAV_ENVIRONMENT": "test",
        "NAV_LOGIN": "...",
        "NAV_PASSWORD": "...",
        "NAV_SIGN_KEY": "...",
        "NAV_EXCHANGE_KEY": "...",
        "NAV_TAX_NUMBER": "12345678",
        "NAV_SOFTWARE_ID": "..."
      }
    }
  }
}
```

Same variables as the CLI, so one configuration serves both.
`NAV_TAX_NUMBER` is the **8 digit** core number, not the 11 digit form.

## Tools

Four work with no credentials at all:

| Tool                | What it does                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `validate_invoice`  | Check invoice data against the schema and the business rules, with NAV's own fault codes |
| `lookup_fault_code` | Explain a NAV fault code in NAV's words, in `hu`, `en` or `de`                           |
| `render_invoice`    | Render a printable invoice, with the phrases the VAT Act requires                        |
| `export_invoices`   | Build the data export required by decree 23/2014. (VI. 30.) NGM                          |

Five more appear once credentials are configured:

| Tool                 | What it does                                           |
| -------------------- | ------------------------------------------------------ |
| `query_taxpayer`     | The authoritative check on a Hungarian tax number      |
| `submit_invoices`    | Report invoice data; validates locally first           |
| `transaction_status` | The verdict on a submission, optionally waiting for it |
| `list_invoices`      | Invoices issued by you or to you, in a date range      |
| `get_invoice`        | One invoice in full, as reported                       |

## Decisions that matter for an agent

**Tools that cannot work are not offered.** Without credentials the NAV tools
are not registered at all, so an agent is never handed a tool that is
guaranteed to fail, and never has to discover that by calling it.

**A validation failure is a result, not an error.** The fault list _is_ the
answer, and returning it as an error would hide it behind an exception. Real
errors — a document that is not an invoice, a NAV rejection — do come back as
errors, carrying the fault code so the agent can act on it.

**`submit_invoices` validates before sending** and refuses a document with
errors. A rejection costs a round trip and consumes the request id, and an
agent that retries blindly would burn both.

**Credentials never travel as tool arguments.** A tool argument passes through
the agent's context and its transcript; an environment variable does not.

**Everything is structured content**, not prose to be re-parsed.

## Trying it without credentials

```sh
npx @open-nav/mock-server            # prints fake credentials
```

Point `NAV_BASE_URL` at the mock and the whole tool set works, including
submission, against a service that verifies signatures the way NAV does. That
is how this package's own tests exercise it.

## Licence

MIT. Not affiliated with NAV.
