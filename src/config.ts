import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from './types.js';
import { createLogger, setLogLevel } from './logger.js';

const log = createLogger('config');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

/**
 * Load .env file into process.env (simple parser; no dependency needed).
 */
function loadDotEnv(): void {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
      const value = process.env[varName];
      if (value === undefined) {
        log.warn(`Environment variable ${varName} is not set`);
        return '';
      }
      return value;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      resolved[key] = resolveEnvVars(value);
    }
    return resolved;
  }
  return obj;
}

export function loadConfig(): AppConfig {
  loadDotEnv();

  const settingsPath = path.join(PROJECT_ROOT, 'config', 'settings.yaml');
  const domainsPath = path.join(PROJECT_ROOT, 'config', 'trusted_domains.yaml');

  const settingsRaw = fs.readFileSync(settingsPath, 'utf-8');
  const settings = resolveEnvVars(parseYaml(settingsRaw)) as Record<string, unknown>;

  let trustedDomains: string[] = [];
  let blockedDomains: string[] = [];

  if (fs.existsSync(domainsPath)) {
    const domainsRaw = fs.readFileSync(domainsPath, 'utf-8');
    const domains = parseYaml(domainsRaw) as Record<string, unknown>;

    if (domains.allowlist && Array.isArray(domains.allowlist)) {
      trustedDomains = domains.allowlist
        .filter((d: unknown) => typeof d === 'object' && d !== null && 'domain' in d)
        .map((d: unknown) => (d as { domain: string }).domain);
    }
    if (domains.blocklist && Array.isArray(domains.blocklist)) {
      blockedDomains = domains.blocklist
        .filter((d: unknown) => typeof d === 'object' && d !== null && 'domain' in d)
        .map((d: unknown) => (d as { domain: string }).domain);
    }
  }

  const s = settings as Record<string, Record<string, unknown>>;

  const config: AppConfig = {
    model: s.model as unknown as AppConfig['model'],
    email: s.email as unknown as AppConfig['email'],
    calendar: s.calendar as unknown as AppConfig['calendar'],
    notifications: s.notifications as unknown as AppConfig['notifications'],
    safety: s.safety as unknown as AppConfig['safety'],
    absence: s.absence as unknown as AppConfig['absence'],
    webhook: s.webhook as unknown as AppConfig['webhook'],
    logging: s.logging as unknown as AppConfig['logging'],
    trustedDomains,
    blockedDomains,
  };

  setLogLevel(config.logging.level);

  log.info('Configuration loaded', {
    model: config.model.name,
    endpoint: config.model.endpoint,
    returnDate: config.absence.return_date,
  });

  return config;
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
