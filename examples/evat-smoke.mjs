// Live smoke test for @open-nav/evat against NAV's eÁFA (eVAT) TEST system.
//
// Credentials come from the gitignored .env (the same NAV_* technical user as
// the Online Számla example — eVAT reuses it). Load it and run:
//
//   pnpm build                                    # the script imports built dist
//   node --env-file=.env examples/evat-smoke.mjs
//
// Required in .env: NAV_LOGIN, NAV_PASSWORD, NAV_SIGN_KEY, NAV_TAX_NUMBER.
// Optional: NAV_SOFTWARE_ID, NAV_SOFTWARE_DEV_TAX_NUMBER, NAV_EXCHANGE_KEY.
//
// It is read-only apart from an attachment upload that is immediately purged, so
// it leaves no data behind and is safe to run repeatedly. The attachment
// roundtrip is the important check: it exercises the exact multipart machinery
// (part names `body`+`file`, SHA3-512 content hash, the folded file-upload
// signature) that declaration partition upload uses. The declaration/tax-code
// reads need extra NAV permissions on the technical user; the script reports a
// FORBIDDEN on those as a permission note rather than a hard failure.
import { NavApiError } from '@open-nav/core';
import { EvatClient } from '@open-nav/evat';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(
      `Missing required env var ${name}. Run: node --env-file=.env examples/evat-smoke.mjs`,
    );
    process.exit(2);
  }
  return value;
}

const credentials = {
  login: requireEnv('NAV_LOGIN'),
  password: requireEnv('NAV_PASSWORD'),
  signKey: requireEnv('NAV_SIGN_KEY'),
  taxNumber: requireEnv('NAV_TAX_NUMBER'),
  ...(process.env.NAV_EXCHANGE_KEY ? { exchangeKey: process.env.NAV_EXCHANGE_KEY } : {}),
};

const software = {
  softwareId: process.env.NAV_SOFTWARE_ID ?? 'OPENNAVSMOKE00001',
  softwareName: 'open-nav evat smoke',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'open-nav',
  softwareDevContact: 'dev@example.invalid',
  softwareDevCountryCode: 'HU',
  softwareDevTaxNumber: process.env.NAV_SOFTWARE_DEV_TAX_NUMBER ?? credentials.taxNumber,
};

const environment = process.env.NAV_ENVIRONMENT === 'production' ? 'production' : 'test';
const client = new EvatClient({ credentials, software, environment });

// A minimal valid 1×1 PNG — eÁFA attachments must be PDF, JPEG or PNG.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const today = () => new Date().toISOString().slice(0, 10);
let failed = false;

/** Run a step. `tolerateForbidden` turns a permission error into a note. */
async function step(label, run, { tolerateForbidden = false } = {}) {
  process.stdout.write(`• ${label} … `);
  try {
    const value = await run();
    console.log(`OK (funcCode=${value?.result?.funcCode ?? '-'})`);
    return value;
  } catch (error) {
    if (error instanceof NavApiError && error.errorCode === 'FORBIDDEN' && tolerateForbidden) {
      console.log('FORBIDDEN — technical user lacks this eÁFA permission (skipped)');
      return undefined;
    }
    failed = true;
    if (error instanceof NavApiError) {
      console.log(`FAILED (${error.status} ${error.errorCode ?? '-'})`);
      console.error(`  ${error.message}`);
      if (error.responseBody) console.error(`  ${error.responseBody.slice(0, 400)}`);
    } else {
      console.log('FAILED');
      console.error(`  ${error?.stack ?? error}`);
    }
    return undefined;
  }
}

console.log(
  `eÁFA ${environment} smoke — taxNumber ${credentials.taxNumber}, login ${credentials.login}\n`,
);

// The multipart upload roundtrip — the definitive wire-format check.
const upload = await step('manageAttachmentUpload (1×1 PNG)', () =>
  client.manageAttachmentUpload(
    { fileName: 'opennav-smoke', fileExtension: 'PNG' },
    new Uint8Array(PNG_1x1),
  ),
);
if (upload?.claimCheckId) {
  await step('queryAttachmentList', () => client.queryAttachmentList());
  await step(`purgeAttachment(${upload.claimCheckId})`, () =>
    client.purgeAttachment(upload.claimCheckId),
  );
}

// Read paths — need extra permissions on the technical user.
await step('queryTaxCodeCatalog(today)', () => client.queryTaxCodeCatalog(today()), {
  tolerateForbidden: true,
});
const to = today();
await step(
  `queryDeclarationList(${to.slice(0, 4)}-01-01..${to})`,
  () =>
    client.queryDeclarationList({
      taxpointDateFrom: `${to.slice(0, 4)}-01-01`,
      taxpointDateTo: to,
    }),
  { tolerateForbidden: true },
);

if (failed) {
  console.error('\nSmoke failed — see the errors above.');
  process.exit(1);
}
console.log('\neÁFA test smoke passed — auth, multipart upload and codec verified live. ✅');
