import { describe, expect, it } from 'vitest';
import {
  configLoadedEvent,
  EnvValidationError,
  httpUrlWithoutCredentials,
  InventoryDriftError,
  NEXT_SERVER_FIELDS,
  readEnv,
  readNextServerConfig,
  type FieldValidator,
} from '../src/index.js';

const text: FieldValidator<string> = {
  safeParse: (v) => (typeof v === 'string' && /^\S+$/.test(v) ? { success: true, data: v } : { success: false }),
};
const port: FieldValidator<number> = {
  safeParse: (v) => (typeof v === 'string' && /^[1-9]\d{0,4}$/.test(v) && Number(v) <= 65535 ? { success: true, data: Number(v) } : { success: false }),
};
const apiFields = { NODE_ENV: text, LOG_LEVEL: text, API_HOST: text, API_PORT: port };

describe('readEnv', () => {
  it('applies inventory defaults only to unset variables and freezes the result', () => {
    const env = readEnv('api', apiFields, { NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: '3000' });
    expect(env).toEqual({ NODE_ENV: 'test', LOG_LEVEL: 'info', API_HOST: '127.0.0.1', API_PORT: 3000 });
    expect(Object.isFrozen(env)).toBe(true);
    expect(() => readEnv('api', apiFields, { NODE_ENV: 'test', API_HOST: 'h', API_PORT: '1', LOG_LEVEL: '' })).toThrow(EnvValidationError);
  });

  it('lists missing and invalid variables by name only, sorted', () => {
    try {
      readEnv('api', apiFields, { API_PORT: 'secret-looking-value' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).variables).toEqual(['API_HOST', 'API_PORT', 'NODE_ENV']);
      expect((error as Error).message).toBe('Invalid or missing environment variables: API_HOST, API_PORT, NODE_ENV');
      expect(JSON.stringify(error)).not.toContain('secret-looking-value');
    }
  });

  it('refuses a configuration module that drifts from the inventory', () => {
    const { API_PORT: _dropped, ...missing } = apiFields;
    expect(() => readEnv('api', missing, {})).toThrow(InventoryDriftError);
    expect(() => readEnv('api', { ...apiFields, EXTRA_SETTING: text }, {})).toThrow(/not in inventory: EXTRA_SETTING/);
  });

  it('ignores variables that are not in the application inventory', () => {
    const env = readEnv('api', apiFields, { NODE_ENV: 'test', API_HOST: 'h', API_PORT: '1', REDIS_URL: 'redis://x' });
    expect(Object.keys(env)).not.toContain('REDIS_URL');
  });
});

describe('Next.js server configuration', () => {
  it('requires an http(s) API_BASE_URL without credentials', () => {
    expect(readNextServerConfig('web', { API_BASE_URL: 'http://api.internal:8080' })).toEqual({ apiBaseUrl: 'http://api.internal:8080' });
    expect(readNextServerConfig('admin', { API_BASE_URL: 'https://api.example' }).apiBaseUrl).toBe('https://api.example');
    for (const bad of [undefined, '', 'not a url', 'ftp://x', 'file:///etc/passwd', 'https://user:placeholder@api.internal', 'https://user@api.internal']) {
      expect(() => readNextServerConfig('web', { API_BASE_URL: bad })).toThrow('Invalid or missing environment variables: API_BASE_URL');
    }
    expect(httpUrlWithoutCredentials.safeParse(42).success).toBe(false);
    expect(Object.keys(NEXT_SERVER_FIELDS)).toEqual(['API_BASE_URL']);
  });
});

describe('config_loaded event', () => {
  it('contains only safe metadata: no values and no variable names', () => {
    const event = configLoadedEvent('worker', { A_NAME: text, B_NAME: text });
    expect(event).toEqual({ event: 'config_loaded', component: 'worker', variablesValidated: 2 });
    expect(JSON.stringify(event)).not.toMatch(/A_NAME|B_NAME/);
  });
});
