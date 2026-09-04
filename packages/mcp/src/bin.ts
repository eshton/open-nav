#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createNavMcpServer } from './server.js';
import { resolveConfig } from './config.js';

const config = resolveConfig();

if (config.missing.length > 0) {
  // stderr, never stdout: stdout carries the MCP protocol.
  process.stderr.write(
    `open-nav MCP: running with the offline tools only.\n` +
      `Set ${config.missing.join(', ')} to enable the tools that talk to NAV.\n`,
  );
}

const server = createNavMcpServer({
  ...(config.credentials ? { credentials: config.credentials } : {}),
  ...(config.software ? { software: config.software } : {}),
  environment: config.environment,
  ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
});

await server.connect(new StdioServerTransport());
