import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../src/server/bff/api-client';
import {
  BffConfigError,
  createInternalCredentialFetch,
  getApiClient,
  INTERNAL_CREDENTIAL_HEADER,
  readBffConfig,
} from '../src/server/bff/index';

/** Obviously fake, 43 base64url characters like the real format. Never a real credential. */
const CREDENTIAL = 'test-current-credential-value-not-a-real-se';
const BASE_URL = 'http://api.internal:8080';
const ENV = { API_BASE_URL: BASE_URL, INTERNAL_BFF_CREDENTIAL: CREDENTIAL };

const BFF_DIR = fileURLToPath(new URL('../src/server/bff/', import.meta.url));
const CONTRACTS_SRC = fileURLToPath(new URL('../../../packages/contracts/src/', import.meta.url));

/** Comments explain the rules; only real code may satisfy or break them. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function sourcesIn(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => {
      const path = `${entry.parentPath}/${entry.name}`;
      return { path, text: readFileSync(path, 'utf8') };
    });
}

afterEach(() => {
  resetApiClientForTests();
  vi.restoreAllMocks();
});

describe('the credential travels with every server-side API call', () => {
  it('attaches the header to a request made through the generated client', async () => {
    const seen: Array<{ url: string; credential: string | null }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), credential: new Headers(init?.headers).get(INTERNAL_CREDENTIAL_HEADER) });
      return new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await getApiClient(ENV).getV1Foundation();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${BASE_URL}/v1/foundation`);
    expect(seen[0]?.credential).toBe(CREDENTIAL);
  });

  it('sends the header on every call, not only the first', async () => {
    const credentials: Array<string | null> = [];
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      credentials.push(new Headers(init?.headers).get(INTERNAL_CREDENTIAL_HEADER));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const client = getApiClient(ENV);
    await client.getHealth();
    await client.getV1Foundation();
    await client.getHealth();

    expect(credentials).toEqual([CREDENTIAL, CREDENTIAL, CREDENTIAL]);
  });

  it('uses exactly the header name the API guard reads', () => {
    // Pinned as a literal: the API is a separate application this app cannot import from, so drift
    // between the two sides would otherwise only show up as a 403 in production.
    expect(INTERNAL_CREDENTIAL_HEADER).toBe('x-internal-credential');
  });
});

describe('the wrapper itself', () => {
  it('preserves the caller’s headers, method and body', async () => {
    let received: Request | undefined;
    const base = (async (input: string | URL | Request, init?: RequestInit) => {
      received = new Request(String(input), init);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await createInternalCredentialFetch(CREDENTIAL, base)('http://api.internal/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
      body: '{"a":1}',
    });

    expect(received?.method).toBe('POST');
    expect(received?.headers.get('content-type')).toBe('application/json');
    expect(received?.headers.get('x-request-id')).toBe('abc');
    expect(received?.headers.get(INTERNAL_CREDENTIAL_HEADER)).toBe(CREDENTIAL);
    expect(await received?.text()).toBe('{"a":1}');
  });

  it('cannot be talked out of the credential by a call site', async () => {
    let credential: string | null = null;
    const base = (async (_input: string | URL | Request, init?: RequestInit) => {
      credential = new Headers(init?.headers).get(INTERNAL_CREDENTIAL_HEADER);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const wrapped = createInternalCredentialFetch(CREDENTIAL, base);

    // The header is applied after the caller's own headers, so an override is ignored rather than
    // silently producing a request the API will refuse.
    await wrapped('http://api.internal/x', { headers: { [INTERNAL_CREDENTIAL_HEADER]: 'attacker-supplied' } });
    expect(credential).toBe(CREDENTIAL);

    await wrapped('http://api.internal/x', { headers: new Headers({ 'X-Internal-Credential': 'attacker-supplied' }) });
    expect(credential).toBe(CREDENTIAL);
  });

  it('keeps the credential in a closure, readable from nothing', () => {
    const wrapped = createInternalCredentialFetch(CREDENTIAL);
    expect(Object.values(wrapped)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(wrapped) ?? '').not.toContain(CREDENTIAL);
    expect(String(wrapped)).not.toContain(CREDENTIAL);
  });
});

describe('server-only boundaries', () => {
  it('marks every BFF module server-only', () => {
    const files = sourcesIn(BFF_DIR);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      expect(file.text.startsWith("import 'server-only';"), file.path).toBe(true);
    }
  });

  it('leaves @repo/contracts with no knowledge of the credential or the header', () => {
    for (const file of sourcesIn(CONTRACTS_SRC)) {
      expect(file.text, file.path).not.toMatch(/INTERNAL_BFF_CREDENTIAL|x-internal-credential|internalBffCredential/i);
    }
  });

  it('never names the variable in application source, so nothing can read it a second way', () => {
    // The value arrives through `@repo/server-config`'s reader. No module in this app names the
    // variable, hard-codes it, or reaches for `process.env` to fetch it again.
    for (const file of sourcesIn(fileURLToPath(new URL('../src/', import.meta.url)))) {
      expect(withoutComments(file.text), file.path).not.toMatch(/INTERNAL_BFF_CREDENTIAL/);
    }
  });

  it('never names the credential with a NEXT_PUBLIC_ prefix', () => {
    for (const file of sourcesIn(fileURLToPath(new URL('../src/', import.meta.url)))) {
      expect(withoutComments(file.text), file.path).not.toContain('NEXT_PUBLIC_');
    }
  });
});

describe('failing safely', () => {
  it('refuses to build a client when the credential is missing, before any request is made', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(() => getApiClient({ API_BASE_URL: BASE_URL })).toThrow(BffConfigError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'too-short'],
    ['not base64url', 'test-current-credential-value-not-a-real-s!'],
    ['a CURRENT,PREVIOUS pair, which a BFF never sends', `${CREDENTIAL},test-previous-credential-value-not-a-real-s`],
  ])('rejects a %s credential by name, never by value', (_label, value) => {
    try {
      readBffConfig({ API_BASE_URL: BASE_URL, INTERNAL_BFF_CREDENTIAL: value });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BffConfigError);
      expect((error as BffConfigError).variables).toEqual(['INTERNAL_BFF_CREDENTIAL']);
      expect((error as Error).message).toBe('Invalid or missing environment variables: INTERNAL_BFF_CREDENTIAL');
      if (typeof value === 'string' && value !== '') {
        expect(`${(error as Error).message}${JSON.stringify(error)}`).not.toContain(value);
      }
    }
  });

  it('accepts a valid credential', () => {
    expect(readBffConfig(ENV)).toEqual({ apiBaseUrl: BASE_URL, internalBffCredential: CREDENTIAL });
  });
});
