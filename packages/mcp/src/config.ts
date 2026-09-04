import type { SoftwareType } from '@open-nav/core';
import type { NavCredentials } from '@open-nav/client';
import { VERSION } from './version.js';

/**
 * Configuration from the environment, using the same variables as the CLI so
 * one `.env` serves both.
 *
 * Credentials are never taken as tool arguments. A tool argument travels
 * through the agent's context and its transcript; an environment variable does
 * not.
 */
export interface ResolvedConfig {
  credentials?: NavCredentials;
  software?: SoftwareType;
  environment: 'test' | 'production';
  baseUrl?: string;
  /** Which required variables are absent, if any. */
  missing: string[];
}

const REQUIRED = [
  'NAV_LOGIN',
  'NAV_PASSWORD',
  'NAV_SIGN_KEY',
  'NAV_EXCHANGE_KEY',
  'NAV_TAX_NUMBER',
  'NAV_SOFTWARE_ID',
] as const;

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): ResolvedConfig {
  const missing = REQUIRED.filter((name) => !env[name]);
  const environment = env['NAV_ENVIRONMENT'] === 'production' ? 'production' : 'test';

  if (missing.length > 0) {
    return {
      environment,
      missing,
      ...(env['NAV_BASE_URL'] ? { baseUrl: env['NAV_BASE_URL'] } : {}),
    };
  }

  const operation =
    env['NAV_SOFTWARE_OPERATION'] === 'ONLINE_SERVICE' ? 'ONLINE_SERVICE' : 'LOCAL_SOFTWARE';

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
      softwareName: env['NAV_SOFTWARE_NAME'] ?? 'open-nav',
      softwareOperation: operation,
      softwareMainVersion: env['NAV_SOFTWARE_VERSION'] ?? VERSION,
      softwareDevName: env['NAV_SOFTWARE_DEV_NAME'] ?? 'open-nav',
      softwareDevContact: env['NAV_SOFTWARE_DEV_CONTACT'] ?? 'unknown',
      ...(env['NAV_SOFTWARE_DEV_TAX_NUMBER']
        ? { softwareDevTaxNumber: env['NAV_SOFTWARE_DEV_TAX_NUMBER'] }
        : {}),
    },
    environment,
    ...(env['NAV_BASE_URL'] ? { baseUrl: env['NAV_BASE_URL'] } : {}),
    missing: [],
  };
}
