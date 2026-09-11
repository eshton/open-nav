// End-to-end example: validate an invoice, report it to NAV, poll for the
// verdict, and render the printable PDF — the whole round trip a consuming
// project makes.
//
// It runs against the local mock service by default, so `node report-invoice.mjs`
// works with no credentials. Set the NAV_* variables (see below) to point it at
// NAV's real test system instead.
//
//   pnpm --filter @open-nav/examples report
//   node examples/report-invoice.mjs
//
// It also runs in CI as an integration smoke test: it exits non-zero if any
// step fails.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseDocument, validateInvoice } from '@open-nav/core';
import { NavClient, waitForTransaction } from '@open-nav/client';
import { renderInvoicePdfNative } from '@open-nav/invoicing';
import { startMockServer } from '@open-nav/mock-server';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// 1. Get an invoice. A real project builds an `InvoiceData` object (the type
//    from @open-nav/core); here we start from one of NAV's own samples so the
//    example stays short. Everything below is identical whichever way you got it.
const sampleXml = readFileSync(
  join(repoRoot, 'conformance', 'data-samples', 'belfoldi-termekertekesites.xml'),
  'utf8',
);
const invoice = parseDocument(sampleXml).value;
console.log(`1. Loaded invoice ${invoice.invoiceNumber}`);

// 2. Validate locally — the whole point of the library is to catch what NAV
//    would reject before spending a network round trip on it.
const report = validateInvoice(invoice, { operation: 'CREATE' });
if (!report.valid) {
  for (const issue of report.errors) console.error(issue.code, issue.path, issue.message);
  throw new Error('invoice failed local validation');
}
console.log(`2. Validated locally: ${report.warnings.length} warning(s), no errors`);

// 3. Configure the client. Credentials come from the environment, never from
//    arguments. With none set we spin up the local mock, which verifies the
//    request signature the way NAV does and decides the invoice's fate with
//    this same validator.
const credentials = {
  login: process.env.NAV_LOGIN ?? 'mocklogin123',
  password: process.env.NAV_PASSWORD ?? 'mock-password',
  signKey: process.env.NAV_SIGN_KEY ?? 'mock-sign-key-0123456789',
  exchangeKey: process.env.NAV_EXCHANGE_KEY ?? '0123456789abcdef',
  // The 8-digit core of the supplier's tax number — must match the invoice.
  taxNumber:
    process.env.NAV_TAX_NUMBER ??
    invoice.invoiceMain.invoice.invoiceHead.supplierInfo.supplierTaxNumber.taxpayerId,
};
const software = {
  softwareId: 'OPENNAVEXAMPLE001',
  softwareName: 'open-nav example',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'open-nav',
  softwareDevContact: 'dev@example.invalid',
};

const usingMock = !process.env.NAV_LOGIN;
const mock = usingMock ? await startMockServer({ credentials }) : undefined;
const client = new NavClient({
  credentials,
  software,
  ...(mock ? { baseUrl: mock.url } : { environment: 'test' }),
});
console.log(`3. Client ready (${usingMock ? 'local mock service' : 'NAV test system'})`);

try {
  // 4. Report the invoice. submitInvoices exchanges a token, encodes the payload
  //    once (both sending and hashing that same base64), and returns a
  //    transaction id — the report is asynchronous.
  const { transactionId } = await client.submitInvoices([{ operation: 'CREATE', invoice }]);
  console.log(`4. Submitted, transaction ${transactionId}`);

  // 5. Poll until every invoice reaches a terminal state.
  const outcome = await waitForTransaction(client, transactionId);
  console.log(
    `5. Verdict: ${outcome.accepted.length} stored, ${outcome.rejected.length} rejected, ${outcome.warnings.length} with warnings`,
  );
  if (outcome.rejected.length > 0) throw new Error('NAV rejected the invoice');

  // 6. Render the printable document. The native engine needs no browser and
  //    embeds a font so the Hungarian characters come out right.
  const pdf = await renderInvoicePdfNative(invoice);
  const safeName = invoice.invoiceNumber.replace(/[^\w.-]+/g, '_');
  const outPath = join(tmpdir(), `${safeName}.pdf`);
  writeFileSync(outPath, pdf);
  console.log(`6. Rendered PDF (${pdf.length} bytes) -> ${outPath}`);

  console.log('\nDone.');
} finally {
  await mock?.close();
}
