import { describe, expect, it } from 'vitest';
import {
  buildInvoice,
  computeInvoiceSummary,
  hungarianToday,
  Decimal,
  type InvoiceData,
  type SoftwareType,
} from '@open-nav/core';
import { NavClient, waitForTransaction, type NavCredentials } from '../src/index.js';

/**
 * Live smoke test against NAV's real test system.
 *
 * It runs ONLY when the technical-user credentials are present in the
 * environment (the same NAV_* variables the CLI and MCP server use), and skips
 * otherwise — so `pnpm test` and CI stay green without credentials, exactly
 * like the browser PDF tests.
 *
 *   NAV_LOGIN=... NAV_PASSWORD=... NAV_SIGN_KEY=... NAV_EXCHANGE_KEY=... \
 *   NAV_TAX_NUMBER=12345678 NAV_SOFTWARE_ID=... \
 *   [NAV_SUPPLIER_TAX_NUMBER=12345678-2-41] \
 *   pnpm --filter @open-nav/client exec vitest run test/live.test.ts
 *
 * The submission test proves the round trip works — auth, signature, submit,
 * poll — and logs NAV's verdict. Whether the invoice is *accepted* depends on
 * your registered data, so it reports the outcome and fault codes rather than
 * assuming acceptance; a transport or signature failure is the real failure.
 */

interface LiveConfig {
  credentials: NavCredentials;
  software: SoftwareType;
  environment: 'test' | 'production';
  baseUrl?: string;
  supplierTaxNumber: string;
}

function liveConfig(env = process.env): LiveConfig | null {
  const required = [
    'NAV_LOGIN',
    'NAV_PASSWORD',
    'NAV_SIGN_KEY',
    'NAV_EXCHANGE_KEY',
    'NAV_TAX_NUMBER',
    'NAV_SOFTWARE_ID',
  ];
  if (required.some((name) => !env[name])) return null;

  return {
    credentials: {
      login: env['NAV_LOGIN']!,
      password: env['NAV_PASSWORD']!,
      signKey: env['NAV_SIGN_KEY']!,
      exchangeKey: env['NAV_EXCHANGE_KEY']!,
      taxNumber: env['NAV_TAX_NUMBER']!,
    },
    software: {
      softwareId: env['NAV_SOFTWARE_ID']!,
      softwareName: env['NAV_SOFTWARE_NAME'] ?? 'open-nav live test',
      softwareOperation:
        env['NAV_SOFTWARE_OPERATION'] === 'ONLINE_SERVICE' ? 'ONLINE_SERVICE' : 'LOCAL_SOFTWARE',
      softwareMainVersion: env['NAV_SOFTWARE_VERSION'] ?? '0.1.1',
      softwareDevName: env['NAV_SOFTWARE_DEV_NAME'] ?? 'open-nav',
      softwareDevContact: env['NAV_SOFTWARE_DEV_CONTACT'] ?? 'dev@example.invalid',
    },
    environment: env['NAV_ENVIRONMENT'] === 'production' ? 'production' : 'test',
    // The invoice supplier needs the full tax number (with VAT + county code);
    // NAV_TAX_NUMBER is the 8-digit auth core. Fall back to it if that's all
    // there is — NAV will then tell us what's missing.
    supplierTaxNumber: env['NAV_SUPPLIER_TAX_NUMBER'] ?? env['NAV_TAX_NUMBER']!,
    ...(env['NAV_BASE_URL'] ? { baseUrl: env['NAV_BASE_URL'] } : {}),
  };
}

describe('liveConfig (env parsing)', () => {
  it('returns null when credentials are absent', () => {
    expect(liveConfig({})).toBeNull();
  });

  it('reads the NAV_* variables and defaults to the test environment', () => {
    const cfg = liveConfig({
      NAV_LOGIN: 'l',
      NAV_PASSWORD: 'p',
      NAV_SIGN_KEY: 's',
      NAV_EXCHANGE_KEY: '0123456789abcdef',
      NAV_TAX_NUMBER: '12345678',
      NAV_SOFTWARE_ID: 'SW0000000000001',
    });
    expect(cfg?.credentials.login).toBe('l');
    expect(cfg?.environment).toBe('test');
    expect(cfg?.supplierTaxNumber).toBe('12345678');
  });

  it('prefers a full supplier tax number when given', () => {
    const cfg = liveConfig({
      NAV_LOGIN: 'l',
      NAV_PASSWORD: 'p',
      NAV_SIGN_KEY: 's',
      NAV_EXCHANGE_KEY: '0123456789abcdef',
      NAV_TAX_NUMBER: '12345678',
      NAV_SOFTWARE_ID: 'SW0000000000001',
      NAV_SUPPLIER_TAX_NUMBER: '12345678-2-41',
    });
    expect(cfg?.supplierTaxNumber).toBe('12345678-2-41');
  });
});

const config = liveConfig();
const live = config ? describe : describe.skip;

live('live NAV test system', () => {
  // Built inside each test, not here: a skipped describe still executes its
  // body at collection time, where `config` may be null.
  const makeClient = (): NavClient =>
    new NavClient({
      credentials: config!.credentials,
      software: config!.software,
      environment: config!.environment,
      ...(config!.baseUrl ? { baseUrl: config!.baseUrl } : {}),
    });

  it('exchanges a token', async () => {
    const { token, validityTo } = await makeClient().tokenExchange();
    expect(token).toBeTruthy();
    console.log(`token exchange OK (valid to ${validityTo})`);
  });

  it('looks up the authenticated taxpayer', async () => {
    const response = await makeClient().queryTaxpayer({ taxNumber: config!.credentials.taxNumber });
    console.log(
      `queryTaxpayer(${config!.credentials.taxNumber}) valid=${response.taxpayerValidity}`,
    );
    expect(response).toBeDefined();
  });

  const sampleInvoice = (invoiceNumber: string): InvoiceData =>
    buildInvoice({
      invoiceNumber,
      issueDate: hungarianToday(),
      paymentDate: hungarianToday(),
      paymentMethod: 'TRANSFER',
      supplier: {
        name: 'open-nav test supplier',
        taxNumber: config!.supplierTaxNumber,
        address: {
          postalCode: '1011',
          city: 'Budapest',
          streetName: 'Fő',
          publicPlaceCategory: 'utca',
          number: '1',
        },
      },
      customer: {
        name: 'Teszt Magánszemély',
        vatStatus: 'PRIVATE_PERSON',
        address: {
          postalCode: '7600',
          city: 'Pécs',
          streetName: 'Rákóczi',
          publicPlaceCategory: 'út',
          number: '2',
        },
      },
      lines: [
        { description: 'open-nav live test', quantity: 1, unitPrice: 1000, vatPercentage: 0.27 },
      ],
    });

  const logVerdict = (
    label: string,
    outcome: Awaited<ReturnType<typeof waitForTransaction>>,
  ): void => {
    console.log(
      `${label} verdict: ${outcome.accepted.length} accepted, ${outcome.rejected.length} rejected, ${outcome.warnings.length} with warnings`,
    );
    for (const result of outcome.results) {
      for (const message of result.businessValidationMessages ?? []) {
        console.log(
          `  line ${result.index} [${message.validationResultCode}] ${message.validationErrorCode ?? ''} ${message.message ?? ''}`,
        );
      }
    }
  };

  const negate = (obj: Record<string, string>, key: string): void => {
    obj[key] = Decimal.from(obj[key]!).negate().toString();
  };

  /** A STORNO of a created invoice: reverse every amount, reference the original. */
  const stornoOf = (created: InvoiceData, newNumber: string): InvoiceData => {
    const doc = structuredClone(created);
    doc.invoiceNumber = newNumber;
    const invoice = doc.invoiceMain.invoice!;
    invoice.invoiceReference = {
      originalInvoiceNumber: created.invoiceNumber,
      modifyWithoutMaster: false,
      modificationIndex: 1,
    };
    // NAV requires lineOperation CREATE on every line of a modifying/cancelling
    // report (INVALID_LINE_OPERATION otherwise). The precise chain line-
    // numbering for a storno follows NAV's modification spec — tracked
    // separately; this exercises the client round trip and NAV's verdict.
    for (const line of invoice.invoiceLines!.line) {
      line.lineModificationReference = {
        lineNumberReference: line.lineNumber,
        lineOperation: 'CREATE',
      };
      const amounts = line.lineAmountsNormal!;
      negate(amounts.lineNetAmountData as unknown as Record<string, string>, 'lineNetAmount');
      negate(amounts.lineNetAmountData as unknown as Record<string, string>, 'lineNetAmountHUF');
      if (amounts.lineVatData) {
        negate(amounts.lineVatData as unknown as Record<string, string>, 'lineVatAmount');
        negate(amounts.lineVatData as unknown as Record<string, string>, 'lineVatAmountHUF');
      }
      if (amounts.lineGrossAmountData) {
        negate(
          amounts.lineGrossAmountData as unknown as Record<string, string>,
          'lineGrossAmountNormal',
        );
        negate(
          amounts.lineGrossAmountData as unknown as Record<string, string>,
          'lineGrossAmountNormalHUF',
        );
      }
    }
    invoice.invoiceSummary = computeInvoiceSummary(invoice);
    return doc;
  };

  it('submits an invoice and reaches a verdict', { timeout: 120_000 }, async () => {
    const client = makeClient();
    const number = `ONAV-LIVE-${Date.now()}`;
    const { transactionId } = await client.submitInvoices([
      { operation: 'CREATE', invoice: sampleInvoice(number) },
    ]);
    expect(transactionId).toBeTruthy();
    const outcome = await waitForTransaction(client, transactionId);
    logVerdict('CREATE', outcome);
    expect(outcome.results.length).toBeGreaterThan(0);
  });

  it('storno cancels a reported invoice', { timeout: 180_000 }, async () => {
    const client = makeClient();
    const created = sampleInvoice(`ONAV-LIVE-${Date.now()}`);
    const create = await client.submitInvoices([{ operation: 'CREATE', invoice: created }]);
    await waitForTransaction(client, create.transactionId);

    const storno = stornoOf(created, `ONAV-STRN-${Date.now()}`);
    const { transactionId } = await client.submitInvoices([
      { operation: 'STORNO', invoice: storno },
    ]);
    const outcome = await waitForTransaction(client, transactionId);
    logVerdict('STORNO', outcome);
    expect(outcome.results.length).toBeGreaterThan(0);
  });

  it('technically annuls an invoice report', { timeout: 180_000 }, async () => {
    const client = makeClient();
    const number = `ONAV-LIVE-${Date.now()}`;
    const create = await client.submitInvoices([
      { operation: 'CREATE', invoice: sampleInvoice(number) },
    ]);
    await waitForTransaction(client, create.transactionId);

    const { transactionId } = await client.submitAnnulments([
      {
        annulmentReference: number,
        annulmentTimestamp: new Date().toISOString(),
        annulmentCode: 'ERRATIC_DATA',
        annulmentReason: 'open-nav live test',
      },
    ]);
    const outcome = await waitForTransaction(client, transactionId);
    logVerdict('ANNUL', outcome);
    expect(outcome.results.length).toBeGreaterThan(0);
  });
});
