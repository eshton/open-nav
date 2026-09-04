import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  NavApiError,
  decodeInvoiceData,
  faultMessage,
  parseDocument,
  parseTaxNumber,
  serializeDocument,
  validateInvoice,
  type InvoiceData,
  type SoftwareType,
} from '@open-nav/core';
import { NavClient, waitForTransaction, type NavCredentials } from '@open-nav/client';
import { createDataExport, renderInvoiceHtml } from '@open-nav/invoicing';
import { VERSION } from './version.js';

/**
 * MCP server for the Online Számla invoice service.
 *
 * Shaped for an agent rather than for a person. Three things follow from
 * that:
 *
 * - Tools that need no credentials are always registered, so an agent can
 *   validate and render invoices before anyone has a technical user.
 * - Tools that reach NAV are registered only when credentials are present,
 *   so an agent is never offered a tool that cannot work, and never has to
 *   discover that by calling it.
 * - Every result is structured content, not prose, and a validation failure
 *   is a normal result rather than an error: the fault list *is* the answer.
 */

export interface NavMcpOptions {
  /** Credentials. Omit to run with the offline tools only. */
  credentials?: NavCredentials;
  software?: SoftwareType;
  environment?: 'test' | 'production';
  baseUrl?: string;
  /** Injected for tests. */
  createClient?: (options: { credentials: NavCredentials }) => NavClient;
}

const OPERATION = z
  .enum(['CREATE', 'MODIFY', 'STORNO'])
  .describe('The operation the document will be submitted under');

const LANGUAGE = z.enum(['en', 'hu', 'de']).describe("Language for NAV's own fault descriptions");

const DIRECTION = z
  .enum(['OUTBOUND', 'INBOUND'])
  .describe('OUTBOUND for invoices you issued, INBOUND for invoices issued to you');

/** Wrap a value as an MCP tool result carrying both text and structure. */
function result(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/** An error an agent can act on, rather than a stack trace. */
function failure(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const detail =
    error instanceof NavApiError
      ? {
          message: error.message,
          errorCode: error.errorCode,
          funcCode: error.funcCode,
          status: error.status,
          validationMessages: error.validationMessages,
        }
      : { message: (error as Error).message ?? String(error) };
  return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }], isError: true };
}

function parseInvoice(xml: string): InvoiceData {
  const parsed = parseDocument(xml, { unknownElements: 'ignore' });
  if (parsed.root !== 'InvoiceData') {
    throw new Error(`Expected an InvoiceData document, found ${parsed.root}`);
  }
  return parsed.value as InvoiceData;
}

export function createNavMcpServer(options: NavMcpOptions = {}): McpServer {
  const server = new McpServer({ name: 'open-nav', version: VERSION });
  registerOfflineTools(server);
  if (options.credentials && options.software) {
    registerOnlineTools(server, {
      ...options,
      credentials: options.credentials,
      software: options.software,
    });
  }
  return server;
}

/** Tools that contact nothing and need no credentials. */
function registerOfflineTools(server: McpServer): void {
  server.registerTool(
    'validate_invoice',
    {
      title: 'Validate invoice data',
      description:
        'Check NAV invoice data (InvoiceData XML) against the schema and the business rules ' +
        'that are decidable from the document alone. Returns every finding with NAV’s own ' +
        'fault code, so a failure here names what the service would have rejected. Needs no ' +
        'credentials. Errors block a submission; warnings do not.',
      inputSchema: {
        xml: z.string().describe('The InvoiceData XML document to check'),
        operation: OPERATION.optional(),
        language: LANGUAGE.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ xml, operation, language }) => {
      try {
        const report = validateInvoice(parseInvoice(xml), {
          ...(operation ? { operation } : {}),
          ...(language ? { language } : {}),
        });
        // A failed validation is the answer, not an error.
        return result({
          valid: report.valid,
          errorCount: report.errors.length,
          warningCount: report.warnings.length,
          issues: report.issues,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'lookup_fault_code',
    {
      title: 'Look up a NAV fault code',
      description:
        'Explain a NAV validation fault code, such as INCORRECT_SUMMARY_CALCULATION_' +
        "INVOICE_VAT_AMOUNT_SUMMARY, in NAV's own words. Use this to interpret a rejection.",
      inputSchema: {
        code: z.string().describe('The fault code, as NAV reported it'),
        language: LANGUAGE.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ code, language }) => {
      const normalised = code.trim().toUpperCase();
      const message = faultMessage(normalised as 'SCHEMA_VIOLATION', language ?? 'en');
      if (!message) {
        return failure(new Error(`NAV defines no fault code ${normalised}`));
      }
      return result({ code: normalised, language: language ?? 'en', message });
    },
  );

  server.registerTool(
    'render_invoice',
    {
      title: 'Render a printable invoice',
      description:
        'Render NAV invoice data as a self-contained, printable HTML invoice, with the phrases ' +
        'the VAT Act requires derived from the data. Convert to PDF with any browser. Needs no ' +
        'credentials.',
      inputSchema: {
        xml: z.string().describe('The InvoiceData XML document to render'),
        language: z
          .enum(['hu', 'en'])
          .optional()
          .describe('Document language, Hungarian by default'),
        note: z.string().optional().describe('Extra note printed under the totals'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ xml, language, note }) => {
      try {
        const html = renderInvoiceHtml(parseInvoice(xml), {
          ...(language ? { language } : {}),
          ...(note ? { note } : {}),
        });
        return {
          content: [{ type: 'text' as const, text: html }],
          structuredContent: { html, bytes: html.length },
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'export_invoices',
    {
      title: 'Produce the tax authority data export',
      description:
        'Build the data export required of invoicing programs by decree 23/2014. (VI. 30.) NGM ' +
        'from a set of InvoiceData documents, selected by issue date or invoice number range. ' +
        'Returns the files rather than writing them. Needs no credentials.',
      inputSchema: {
        invoices: z.array(z.string()).describe('InvoiceData XML documents'),
        issueDateFrom: z.string().optional().describe('First issue date, inclusive, as yyyy-mm-dd'),
        issueDateTo: z.string().optional().describe('Last issue date, inclusive'),
        invoiceNumberFrom: z.string().optional(),
        invoiceNumberTo: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ invoices, ...selection }) => {
      try {
        const parsed = invoices.map((xml) => parseInvoice(xml));
        const exported = createDataExport(parsed, selection);
        return result({
          manifest: exported.manifest,
          files: exported.files,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
}

/** Tools that talk to NAV. Registered only when credentials are configured. */
function registerOnlineTools(
  server: McpServer,
  options: NavMcpOptions & { credentials: NavCredentials; software: SoftwareType },
): void {
  const client = (): NavClient =>
    options.createClient
      ? options.createClient({ credentials: options.credentials })
      : new NavClient({
          credentials: options.credentials,
          software: options.software,
          environment: options.environment ?? 'test',
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        });

  server.registerTool(
    'query_taxpayer',
    {
      title: 'Look up a Hungarian taxpayer',
      description:
        "Check whether a Hungarian tax number is valid and registered, and get the taxpayer's " +
        'name. This is the authoritative check on a tax number; a check digit is not. Accepts ' +
        'the 8 digit core or the 11 digit written form.',
      inputSchema: { taxNumber: z.string().describe('8 or 11 digit Hungarian tax number') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taxNumber }) => {
      try {
        const { taxpayerId } = parseTaxNumber(taxNumber);
        const response = await client().queryTaxpayer({ taxNumber: taxpayerId });
        return result({
          taxNumber: taxpayerId,
          valid: response.taxpayerValidity ?? false,
          taxpayer: response.taxpayerData ?? null,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'submit_invoices',
    {
      title: 'Submit invoice data to NAV',
      description:
        'Report invoice data to NAV. Validates locally first and refuses to submit a document ' +
        'with errors, because a rejection costs a round trip and consumes the request id. ' +
        'Returns the transaction id, and the per-invoice verdict when waitForVerdict is set. ' +
        'This reports data to the tax authority and cannot be undone except by a technical ' +
        'annulment.',
      inputSchema: {
        invoices: z.array(z.string()).describe('InvoiceData XML documents to report'),
        operation: OPERATION.optional(),
        compress: z.boolean().optional().describe('Gzip the payloads'),
        waitForVerdict: z
          .boolean()
          .optional()
          .describe('Poll until NAV decides, and return the per-invoice outcome'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ invoices, operation, compress, waitForVerdict }) => {
      try {
        const parsed = invoices.map((xml) => parseInvoice(xml));
        const effective = operation ?? 'CREATE';

        const blocking = parsed
          .map((invoice, index) => ({
            index,
            report: validateInvoice(invoice, { operation: effective }),
          }))
          .filter((entry) => !entry.report.valid);

        if (blocking.length > 0) {
          return result({
            submitted: false,
            reason: 'local validation failed',
            invalid: blocking.map((entry) => ({
              index: entry.index,
              errors: entry.report.errors,
            })),
          });
        }

        const navClient = client();
        const response = await navClient.submitInvoices(
          parsed.map((invoice) => ({ operation: effective, invoice })),
          { compress: compress ?? false },
        );

        if (!waitForVerdict) {
          return result({
            submitted: true,
            transactionId: response.transactionId,
            count: parsed.length,
          });
        }

        const outcome = await waitForTransaction(navClient, response.transactionId);
        return result({
          submitted: true,
          transactionId: response.transactionId,
          accepted: outcome.accepted.length,
          rejected: outcome.rejected.length,
          results: outcome.results,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'transaction_status',
    {
      title: 'Check a submission',
      description:
        'Get the processing status of a submitted transaction. NAV validates asynchronously, ' +
        'so a submission has no verdict until this reports one.',
      inputSchema: {
        transactionId: z.string(),
        waitForVerdict: z.boolean().optional().describe('Poll until NAV decides'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ transactionId, waitForVerdict }) => {
      try {
        const navClient = client();
        if (waitForVerdict) {
          const outcome = await waitForTransaction(navClient, transactionId);
          return result({
            transactionId,
            accepted: outcome.accepted.length,
            rejected: outcome.rejected.length,
            results: outcome.results,
          });
        }
        const response = await navClient.queryTransactionStatus({ transactionId });
        return result({
          transactionId,
          results: response.processingResults?.processingResult ?? [],
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'list_invoices',
    {
      title: 'List invoices in a date range',
      description:
        'List invoices issued by you (OUTBOUND) or issued to you (INBOUND) in a range of issue ' +
        'dates. Returns a summary per invoice; use get_invoice for the full data. Paged, 100 ' +
        'per page.',
      inputSchema: {
        dateFrom: z.string().describe('First issue date, inclusive, as yyyy-mm-dd'),
        dateTo: z.string().describe('Last issue date, inclusive, as yyyy-mm-dd'),
        direction: DIRECTION.optional(),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ dateFrom, dateTo, direction, page }) => {
      try {
        const response = await client().queryInvoiceDigest({
          page: page ?? 1,
          invoiceDirection: direction ?? 'OUTBOUND',
          invoiceQueryParams: { mandatoryQueryParams: { invoiceIssueDate: { dateFrom, dateTo } } },
        });
        const digest = response.invoiceDigestResult;
        return result({
          page: digest.currentPage,
          availablePages: digest.availablePage,
          invoices: digest.invoiceDigest ?? [],
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'get_invoice',
    {
      title: 'Fetch one invoice in full',
      description:
        'Fetch the complete data of one invoice by number, as reported to NAV. Returns the ' +
        'invoice as XML and as structured data.',
      inputSchema: {
        invoiceNumber: z.string(),
        direction: DIRECTION.optional(),
        supplierTaxNumber: z
          .string()
          .optional()
          .describe('Required for an inbound invoice: who issued it'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ invoiceNumber, direction, supplierTaxNumber }) => {
      try {
        const requested = direction ?? 'OUTBOUND';
        if (requested === 'INBOUND' && !supplierTaxNumber) {
          throw new Error('supplierTaxNumber is required for an inbound invoice');
        }
        const response = await client().queryInvoiceData({
          invoiceNumberQuery: {
            invoiceNumber,
            invoiceDirection: requested,
            ...(supplierTaxNumber
              ? { supplierTaxNumber: parseTaxNumber(supplierTaxNumber).taxpayerId }
              : {}),
          },
        });
        const data = response.invoiceDataResult;
        if (!data) return result({ found: false, invoiceNumber });

        const invoice = decodeInvoiceData(data.invoiceData, {
          compressed: data.compressedContentIndicator,
        });
        return result({
          found: true,
          invoiceNumber,
          auditData: data.auditData,
          xml: serializeDocument('InvoiceData', invoice, { indent: '  ' }),
          invoice,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
