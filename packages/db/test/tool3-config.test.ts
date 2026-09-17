import { describe, expect, it } from 'vitest';
import { readConnections, Tool3ConfigError, withPassword } from '../src/tool3/config.js';

const good = {
  TOOL3_POOLER_URL: 'postgresql://tool3_app_api@127.0.0.1:54329/postgres',
  TOOL3_ADMIN_URL: 'postgresql://postgres:placeholder-not-a-credential@127.0.0.1:54322/postgres',
};
const ports = { pooler: 54329, admin: 54322 };

function error(source: Record<string, string | undefined>, expected = ports): Tool3ConfigError {
  try {
    readConnections('supabase', source, expected);
  } catch (e) {
    if (e instanceof Tool3ConfigError) return e;
    throw e;
  }
  throw new Error('expected Tool3ConfigError');
}

describe('TOOL-3 connection settings', () => {
  it('accepts local pooler and admin URLs on the configured ports', () => {
    const c = readConnections('supabase', good, ports);
    expect(c.target).toBe('supabase');
    expect(c.poolerUrl.port).toBe('54329');
  });

  it('accepts a tenant-qualified fixture user (format confirmed only in CI)', () => {
    expect(() => readConnections('supabase', { ...good, TOOL3_POOLER_URL: 'postgresql://tool3_app_api.some-tenant@127.0.0.1:54329/postgres' }, ports)).not.toThrow();
  });

  it.each([
    ['missing pooler URL', { ...good, TOOL3_POOLER_URL: undefined }, /TOOL3_POOLER_URL is required/],
    ['missing admin URL', { ...good, TOOL3_ADMIN_URL: '' }, /TOOL3_ADMIN_URL is required/],
    ['non-postgres URL', { ...good, TOOL3_POOLER_URL: 'http://tool3_app_api@127.0.0.1:54329/postgres' }, /postgres URL/],
    ['remote host', { ...good, TOOL3_POOLER_URL: 'postgresql://tool3_app_api@db.example.com:54329/postgres' }, /local/],
    ['another user', { ...good, TOOL3_POOLER_URL: 'postgresql://postgres@127.0.0.1:54329/postgres' }, /fixture role/],
    ['password in pooler URL', { ...good, TOOL3_POOLER_URL: 'postgresql://tool3_app_api:pw@127.0.0.1:54329/postgres' }, /must not contain a password/],
    ['admin without password', { ...good, TOOL3_ADMIN_URL: 'postgresql://postgres@127.0.0.1:54322/postgres' }, /user and password/],
    ['same port (no pooler)', { ...good, TOOL3_POOLER_URL: 'postgresql://tool3_app_api@127.0.0.1:54322/postgres' }, /different ports/],
    ['direct port as pooler', { ...good, TOOL3_POOLER_URL: 'postgresql://tool3_app_api@127.0.0.1:5432/postgres' }, /configured pooler port 54329/],
    ['wrong admin port', { ...good, TOOL3_ADMIN_URL: 'postgresql://postgres:x@127.0.0.1:5432/postgres' }, /configured database port 54322/],
    ['different databases', { ...good, TOOL3_ADMIN_URL: 'postgresql://postgres:x@127.0.0.1:54322/other' }, /same database/],
    ['no database', { ...good, TOOL3_POOLER_URL: 'postgresql://tool3_app_api@127.0.0.1:54329' }, /database name/],
  ])('rejects %s', (_label, source, message) => {
    expect(error(source).message).toMatch(message);
  });

  it('never includes URL values or secrets in errors', () => {
    const e = error({ ...good, TOOL3_POOLER_URL: 'postgresql://tool3_app_api:placeholder-must-not-be-printed@127.0.0.1:54329/postgres' });
    expect(e.message).not.toContain('placeholder-must-not-be-printed');
    expect(error({ ...good, TOOL3_ADMIN_URL: 'postgresql://postgres:placeholder-not-a-credential@127.0.0.1:1/postgres' }).message).not.toContain('placeholder-not-a-credential');
  });

  it('does not read the supplemental variables for TOOL-3, and vice versa', () => {
    expect(() => readConnections('supabase', { SUPPLEMENTAL_POOLER_URL: good.TOOL3_POOLER_URL, SUPPLEMENTAL_ADMIN_URL: good.TOOL3_ADMIN_URL }, ports)).toThrow(/TOOL3_POOLER_URL is required/);
    expect(() => readConnections('supplemental', good)).toThrow(/SUPPLEMENTAL_POOLER_URL is required/);
  });

  it('adds the per-run password to the pooler URL', () => {
    const c = readConnections('supabase', good, ports);
    expect(withPassword(c.poolerUrl, 'p@ss/word')).toBe('postgresql://tool3_app_api:p%40ss%2Fword@127.0.0.1:54329/postgres');
  });
});
