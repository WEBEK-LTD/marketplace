import { describe, expect, it } from 'vitest';
import { isAal2, readAssuranceLevel } from '../src/auth/access-token-claims.js';

/**
 * The assurance-level claim reader (Phase 7-F).
 *
 * The property worth testing is not that it reads a claim — it is that **everything it cannot read is
 * `aal1`**. This function is called only on a token the provider has just validated, so its job is to
 * extract one value and to fail closed on every shape it does not recognise. A single branch that
 * returned `aal2` for an unreadable token would be the whole admin console's authorization hole.
 */

function token(payload: unknown, header: unknown = { alg: 'HS256', typ: 'JWT' }): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode(header)}.${encode(payload)}.c2lnbmF0dXJl`;
}

describe('reading the assurance level', () => {
  it('reads aal2 from a token that carries it', () => {
    expect(readAssuranceLevel(token({ sub: 'abc', aal: 'aal2' }))).toBe('aal2');
    expect(isAal2(token({ sub: 'abc', aal: 'aal2' }))).toBe(true);
  });

  it('reads aal1 from a token that carries that', () => {
    expect(readAssuranceLevel(token({ sub: 'abc', aal: 'aal1' }))).toBe('aal1');
    expect(isAal2(token({ sub: 'abc', aal: 'aal1' }))).toBe(false);
  });

  it.each([
    ['no aal claim at all', { sub: 'abc' }],
    ['an aal that is not a string', { aal: 2 }],
    ['an aal that is a truthy object', { aal: { level: 'aal2' } }],
    ['an aal that is an array containing it', { aal: ['aal2'] }],
    ['an aal the provider does not use', { aal: 'aal3' }],
    ['an aal in the wrong case', { aal: 'AAL2' }],
    ['an aal with whitespace', { aal: ' aal2' }],
    ['an empty object', {}],
    ['a payload that is an array', ['aal2']],
    ['a payload that is a string', 'aal2'],
    ['a payload that is null', null],
    ['a payload that is a number', 7],
  ])('answers aal1 for %s', (_name, payload) => {
    expect(readAssuranceLevel(token(payload))).toBe('aal1');
  });

  it.each([
    ['an empty string', ''],
    ['one segment', 'abc'],
    ['two segments', 'abc.def'],
    ['four segments', 'a.b.c.d'],
    ['an empty payload segment', 'abc..c2ln'],
    ['a payload that is not base64url', 'abc.not base64!.c2ln'],
    ['a payload with standard base64 padding', 'abc.YWJjZA==.c2ln'],
    ['a payload that is not JSON', `abc.${Buffer.from('hello', 'utf8').toString('base64url')}.c2ln`],
    ['a payload that is truncated JSON', `abc.${Buffer.from('{"aal":"aal2"', 'utf8').toString('base64url')}.c2ln`],
  ])('answers aal1 for a token that is %s', (_name, value) => {
    expect(readAssuranceLevel(value)).toBe('aal1');
    expect(isAal2(value)).toBe(false);
  });

  it('answers aal1 for a value that is not a string at all', () => {
    expect(readAssuranceLevel(undefined as unknown as string)).toBe('aal1');
    expect(readAssuranceLevel(null as unknown as string)).toBe('aal1');
    expect(readAssuranceLevel({ aal: 'aal2' } as unknown as string)).toBe('aal1');
  });

  it('reads nothing but the assurance level', async () => {
    // Structural: the module names one claim, so no future edit can quietly start trusting `sub`,
    // `role` or `exp` from a body the provider validated but whose fields it does not vouch for.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/auth/access-token-claims.ts', import.meta.url), 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('aal');
    for (const claim of ['sub', 'role', 'exp', 'iat', 'email', 'amr', 'session_id']) {
      expect(code, claim).not.toContain(`.${claim}`);
    }
  });

  it('verifies no signature, and never claims to', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/auth/access-token-claims.ts', import.meta.url), 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // No crypto here by design: the provider established authenticity before this is called, and a
    // half-verification written in this module would be worse than none.
    expect(code).not.toContain('createHmac');
    expect(code).not.toContain('node:crypto');
    expect(code).not.toContain('verify(');
  });
});
