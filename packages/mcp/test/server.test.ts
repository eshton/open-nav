import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startMockServer, type MockServer } from '@open-nav/mock-server';
import type { NavCredentials } from '@open-nav/client';
import type { SoftwareType } from '@open-nav/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createNavMcpServer } from '../src/server.js';
import { resolveConfig } from '../src/config.js';

/**
 * The MCP surface, exercised through a real MCP client over an in-memory
 * transport, and against the mock invoice service for the tools that reach
 * NAV. That covers the whole path an agent takes: tool discovery, argument
 * validation, the call, and the shape of what comes back.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sampleXml = (name = 'belfoldi-termekertekesites.xml'): string =>
  readFileSync(join(REPO_ROOT, 'conformance', 'data-samples', name), 'utf8');

const CREDENTIALS: NavCredentials = {
  login: 'mcplogin1234',
  password: 'mcp-password',
  signKey: 'mcp-sign-key-0123456789',
  exchangeKey: '0123456789abcdef',
  taxNumber: '99999999',
};

const SOFTWARE: SoftwareType = {
  softwareId: 'OPENNAVMCP0000001',
  softwareName: 'open-nav mcp test',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'open-nav',
  softwareDevContact: 'dev@example.invalid',
};

let mock: MockServer | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function connect(options: Parameters<typeof createNavMcpServer>[0] = {}) {
  const server = createNavMcpServer(options);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Tool results carry JSON in their text content. */
function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe('tool discovery', () => {
  it('offers the offline tools with no configuration at all', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'export_invoices',
      'lookup_fault_code',
      'render_invoice',
      'validate_invoice',
    ]);
  });

  it('does not offer tools that cannot work without credentials', async () => {
    // An agent should never be handed a tool that is guaranteed to fail.
    const client = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('submit_invoices');
    expect(names).not.toContain('query_taxpayer');
  });

  it('adds the NAV tools once credentials are configured', async () => {
    const client = await connect({ credentials: CREDENTIALS, software: SOFTWARE });
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'export_invoices',
      'get_invoice',
      'list_invoices',
      'lookup_fault_code',
      'query_taxpayer',
      'render_invoice',
      'submit_invoices',
      'transaction_status',
      'validate_invoice',
    ]);
  });

  it('describes every tool, and marks the read-only ones', async () => {
    const client = await connect({ credentials: CREDENTIALS, software: SOFTWARE });
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema, tool.name).toBeTruthy();
    }
    const submit = tools.find((tool) => tool.name === 'submit_invoices');
    expect(submit?.annotations?.readOnlyHint).toBe(false);
    const validate = tools.find((tool) => tool.name === 'validate_invoice');
    expect(validate?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('validate_invoice', () => {
  it('reports a valid invoice as valid', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'validate_invoice',
      arguments: { xml: sampleXml(), operation: 'CREATE' },
    });
    expect(payload(result)).toMatchObject({ valid: true, errorCount: 0 });
  });

  it('returns the faults as a result, not as an error', async () => {
    // An agent needs the fault list to act on; an error would hide it.
    const client = await connect();
    const result = await client.callTool({
      name: 'validate_invoice',
      arguments: { xml: sampleXml('termekdijas-szamla.xml') },
    });
    expect(result.isError).toBeFalsy();
    const data = payload(result) as { valid: boolean; issues: Array<{ code: string }> };
    expect(data.valid).toBe(false);
    expect(data.issues[0]?.code).toMatch(/^INCORRECT_SUMMARY/);
  });

  it('reports NAV wording in the requested language', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'validate_invoice',
      arguments: { xml: sampleXml('termekdijas-szamla.xml'), language: 'hu' },
    });
    const data = payload(result) as { issues: Array<{ navMessage: string }> };
    expect(data.issues[0]?.navMessage).toMatch(/[áéíóöőúüű]/i);
  });

  it('errors on something that is not an invoice', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'validate_invoice',
      arguments: { xml: '<TokenExchangeRequest/>' },
    });
    expect(result.isError).toBe(true);
  });

  it('explains a call made with the wrong arguments', async () => {
    // The SDK answers with an error result rather than throwing, which is
    // what an agent needs: the message says which argument was wrong.
    const client = await connect();
    const result = await client.callTool({
      name: 'validate_invoice',
      arguments: { operation: 'CREATE' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('xml');
  });
});

describe('lookup_fault_code', () => {
  it('explains a code in NAV’s words', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'lookup_fault_code',
      arguments: { code: 'INVOICE_LINE_MISSING' },
    });
    expect(payload(result)).toMatchObject({
      code: 'INVOICE_LINE_MISSING',
      message: 'The invoice contains no line items.',
    });
  });

  it('accepts a code in any case', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'lookup_fault_code',
      arguments: { code: ' invoice_line_missing ' },
    });
    expect(payload(result)).toMatchObject({ code: 'INVOICE_LINE_MISSING' });
  });

  it('says so when a code is not one NAV defines', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'lookup_fault_code',
      arguments: { code: 'NOT_A_REAL_CODE' },
    });
    expect(result.isError).toBe(true);
  });
});

describe('render_invoice and export_invoices', () => {
  it('renders a printable document', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'render_invoice',
      arguments: { xml: sampleXml() },
    });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text.startsWith('<!doctype html>')).toBe(true);
    expect(text).toContain('Értékesítő Kft');
  });

  it('builds a data export with its manifest', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'export_invoices',
      arguments: { invoices: [sampleXml()], issueDateFrom: '2021-01-01' },
    });
    const data = payload(result) as {
      manifest: { invoiceCount: number; structure: { basis: string } };
      files: Array<{ name: string }>;
    };
    expect(data.manifest.invoiceCount).toBe(1);
    expect(data.manifest.structure.basis).toContain('13/A');
    expect(data.files.map((file) => file.name)).toContain('manifest.json');
  });
});

describe('the tools that talk to NAV', () => {
  async function connectWithMock() {
    mock = await startMockServer({
      credentials: CREDENTIALS,
      taxpayers: [{ taxNumber: '99887764', name: 'Beszerző Kft', valid: true }],
    });
    return connect({ credentials: CREDENTIALS, software: SOFTWARE, baseUrl: mock.url });
  }

  it('looks up a taxpayer, accepting the written form', async () => {
    const client = await connectWithMock();
    const result = await client.callTool({
      name: 'query_taxpayer',
      arguments: { taxNumber: '99887764-2-02' },
    });
    expect(payload(result)).toMatchObject({ taxNumber: '99887764', valid: true });
  });

  it('submits an invoice and can wait for the verdict', async () => {
    const client = await connectWithMock();
    const result = await client.callTool({
      name: 'submit_invoices',
      arguments: { invoices: [sampleXml()], operation: 'CREATE', waitForVerdict: true },
    });
    expect(payload(result)).toMatchObject({ submitted: true, accepted: 1, rejected: 0 });
  });

  it('refuses to submit an invoice that fails local validation', async () => {
    // The round trip and the request id are both spent by a rejection.
    const client = await connectWithMock();
    const broken = sampleXml('termekdijas-szamla.xml');
    const result = await client.callTool({
      name: 'submit_invoices',
      arguments: { invoices: [broken] },
    });
    const data = payload(result) as { submitted: boolean; reason: string };
    expect(data.submitted).toBe(false);
    expect(data.reason).toContain('validation');
    expect(mock?.state.invoices.size).toBe(0);
  });

  it('lists and then fetches an invoice it submitted', async () => {
    const client = await connectWithMock();
    await client.callTool({
      name: 'submit_invoices',
      arguments: { invoices: [sampleXml()], waitForVerdict: true },
    });

    const listed = payload(
      await client.callTool({
        name: 'list_invoices',
        arguments: { dateFrom: '2021-01-01', dateTo: '2021-12-31' },
      }),
    ) as { invoices: Array<{ invoiceNumber: string }> };
    expect(listed.invoices).toHaveLength(1);

    const number = listed.invoices[0]!.invoiceNumber;
    const fetched = payload(
      await client.callTool({ name: 'get_invoice', arguments: { invoiceNumber: number } }),
    ) as { found: boolean; xml: string };
    expect(fetched.found).toBe(true);
    expect(fetched.xml).toContain(number);
  });

  it('requires the supplier for an inbound invoice', async () => {
    const client = await connectWithMock();
    const result = await client.callTool({
      name: 'get_invoice',
      arguments: { invoiceNumber: 'X/1', direction: 'INBOUND' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('supplierTaxNumber');
  });

  it('surfaces a NAV error with its code, for the agent to act on', async () => {
    mock = await startMockServer({ credentials: CREDENTIALS });
    const client = await connect({
      credentials: { ...CREDENTIALS, signKey: 'wrong' },
      software: SOFTWARE,
      baseUrl: mock.url,
    });
    const result = await client.callTool({
      name: 'query_taxpayer',
      arguments: { taxNumber: '99887764' },
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ errorCode: 'INVALID_SIGNATURE' });
  });
});

describe('configuration', () => {
  it('reports what is missing rather than half-configuring', async () => {
    const config = resolveConfig({ NAV_LOGIN: 'x' });
    expect(config.credentials).toBeUndefined();
    expect(config.missing).toContain('NAV_PASSWORD');
  });

  it('defaults to the test system, and takes production only when asked', () => {
    expect(resolveConfig({}).environment).toBe('test');
    expect(resolveConfig({ NAV_ENVIRONMENT: 'production' }).environment).toBe('production');
    expect(resolveConfig({ NAV_ENVIRONMENT: 'nonsense' }).environment).toBe('test');
  });

  it('builds credentials and software once everything is present', () => {
    const config = resolveConfig({
      NAV_LOGIN: 'mcplogin1234',
      NAV_PASSWORD: 'p',
      NAV_SIGN_KEY: 's',
      NAV_EXCHANGE_KEY: '0123456789abcdef',
      NAV_TAX_NUMBER: '99999999',
      NAV_SOFTWARE_ID: 'OPENNAVMCP0000001',
    });
    expect(config.missing).toEqual([]);
    expect(config.credentials?.login).toBe('mcplogin1234');
    expect(config.software?.softwareOperation).toBe('LOCAL_SOFTWARE');
  });
});
