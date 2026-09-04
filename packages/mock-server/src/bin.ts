#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startMockServer } from './server.js';

/**
 * Run the mock service standalone, so the CLI and any other integration can
 * be pointed at it without credentials.
 */
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    polls: { type: 'string' },
    'no-validate': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (values.help === true) {
  console.log(`open-nav-mock — a local stand-in for the NAV Online Számla invoice service

  --port <n>       Port to listen on (default 8080; 0 picks a free one)
  --host <host>    Interface to bind (default 127.0.0.1)
  --polls <n>      Polls before a transaction settles (default 0, immediate)
  --no-validate    Accept every invoice instead of validating it
`);
  process.exit(0);
}

// Obviously fake credentials, printed on startup so they can be copied.
const credentials = {
  login: 'mocklogin123',
  password: 'mock-password',
  signKey: 'mock-sign-key-0123456789',
  exchangeKey: '0123456789abcdef',
  taxNumber: '99999999',
};

const mock = await startMockServer({
  credentials,
  port: values.port === undefined ? 8080 : Number(values.port),
  ...(values.host ? { host: values.host } : {}),
  pollsBeforeDone: values.polls === undefined ? 0 : Number(values.polls),
  validate: values['no-validate'] !== true,
  taxpayers: [
    {
      taxNumber: '99999999',
      name: 'Értékesítő Kft',
      shortName: 'Értékesítő',
      valid: true,
      vatCode: '2',
      countyCode: '41',
    },
    {
      taxNumber: '99887764',
      name: 'Beszerző Kft',
      shortName: 'Beszerző',
      valid: true,
      vatCode: '2',
      countyCode: '02',
    },
  ],
});

console.log(`Mock NAV invoice service listening on ${mock.url}`);
console.log('');
console.log('Point the CLI at it with these (fake) credentials:');
console.log('');
console.log(`  export NAV_BASE_URL=${mock.url}`);
console.log(`  export NAV_LOGIN=${credentials.login}`);
console.log(`  export NAV_PASSWORD=${credentials.password}`);
console.log(`  export NAV_SIGN_KEY=${credentials.signKey}`);
console.log(`  export NAV_EXCHANGE_KEY=${credentials.exchangeKey}`);
console.log(`  export NAV_TAX_NUMBER=${credentials.taxNumber}`);
console.log('  export NAV_SOFTWARE_ID=OPENNAVMOCK000001');
console.log('');
console.log('Then, for example:  open-nav token');
console.log('Press Ctrl+C to stop.');

const shutdown = (): void => {
  void mock.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
