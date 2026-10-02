import { describe, expect, it } from 'vitest';
import {
  SellerMediaStorageUnavailableError,
  SupabaseStorageClient,
} from '../src/sellers/seller-media.storage.js';

/**
 * The storage adapter (Phase 6-E).
 *
 * This is the one piece of 6-E that speaks to a provider, and the tests here are about the two things that are
 * *ours* rather than Supabase's: how the request is composed, and how the answer is read.
 *
 * **What is asserted.** That the project key goes in the headers and never in a URL or a body; that the object
 * path is used exactly as the database composed it, segment-encoded, with its separators intact; that a signed
 * URL is accepted whether the provider returns it relative or absolute and under any of the field names the
 * Storage API has used; that anything else — a body without a URL, an unparsable body, a non-2xx, a timeout, an
 * unreachable host — fails closed as unavailable rather than producing a URL that goes nowhere; and that a 404
 * from the existence check is an answer rather than a failure.
 *
 * **What is not asserted, and cannot be here.** That Supabase Storage's endpoints are spelled the way this
 * adapter spells them. That is provider behaviour, this project asserts none from memory, and the increment
 * report names these two calls as the surface Final QA must confirm against the live service. The defensive
 * parsing below is what makes a wrong guess safe in the meantime: a 503 and no upload, never a broken URL
 * handed to a browser.
 *
 * No live provider, no network: `fetch` is a function.
 */

const CONFIG = {
  url: 'https://project.supabase.invalid',
  secretKey: 'test-secret-key-value-not-a-real-secret-key',
};

const PATH = 'seller-media/good-shop/logo/11111111-1111-1111-1111-111111111111.webp';

interface Seen {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: string | undefined;
}

function responder(
  status: number,
  payload: unknown,
  seen: Seen[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as Record<string, string>),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function client(fetchImpl: typeof fetch): SupabaseStorageClient {
  return new SupabaseStorageClient({ ...CONFIG, fetch: fetchImpl, expirySeconds: 120 });
}

describe('signing an upload', () => {
  it('presents the project key in headers, and nowhere else', async () => {
    const seen: Seen[] = [];
    await client(responder(200, { url: '/object/upload/sign/seller-media/x?token=abc' }, seen)).signUpload(
      'seller-media',
      PATH,
      'image/webp',
    );

    expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${CONFIG.secretKey}`);
    expect(seen[0]?.headers.get('apikey')).toBe(CONFIG.secretKey);
    // Never in the URL, never in the body: a URL lands in access logs and a body in error reports.
    expect(seen[0]?.url).not.toContain(CONFIG.secretKey);
    expect(seen[0]?.body ?? '').not.toContain(CONFIG.secretKey);
  });

  it('uses the path the database composed, with its separators kept and each segment encoded', async () => {
    const seen: Seen[] = [];
    await client(responder(200, { url: '/object/upload/sign/seller-media/x?token=abc' }, seen)).signUpload(
      'seller-media',
      PATH,
      'image/webp',
    );

    expect(seen[0]?.url).toContain(PATH);
    expect(seen[0]?.method).toBe('POST');
    // No path of the adapter's own invention: the bucket appears once as a segment, once inside the path the
    // database built, and nowhere else.
    expect(seen[0]?.url.startsWith(`${CONFIG.url}/storage/v1/`)).toBe(true);
  });

  it('asks for the configured expiry and passes the content type through', async () => {
    const seen: Seen[] = [];
    await client(responder(200, { url: '/object/upload/sign/x?token=abc' }, seen)).signUpload(
      'seller-media',
      PATH,
      'image/avif',
    );

    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ expiresIn: 120, contentType: 'image/avif' });
  });

  it.each([
    ['url', '/object/upload/sign/seller-media/x?token=abc'],
    ['signedUrl', '/object/upload/sign/seller-media/x?token=abc'],
    ['signedURL', '/object/upload/sign/seller-media/x?token=abc'],
    ['url', 'object/upload/sign/seller-media/x?token=abc'],
    ['signedUrl', 'object/upload/sign/seller-media/x?token=abc'],
  ])('accepts a relative signed URL under the field name %s, with or without a leading slash', async (field, value) => {
    const seen: Seen[] = [];
    const signed = await client(responder(200, { [field]: value }, seen)).signUpload(
      'seller-media',
      PATH,
      'image/webp',
    );

    expect(signed.uploadUrl).toBe(
      'https://project.supabase.invalid/storage/v1/object/upload/sign/seller-media/x?token=abc',
    );
  });

  it('accepts an absolute signed URL unchanged', async () => {
    const seen: Seen[] = [];
    const absolute = 'https://project.supabase.invalid/storage/v1/object/upload/sign/seller-media/x?token=abc';
    const signed = await client(responder(200, { url: absolute }, seen)).signUpload(
      'seller-media',
      PATH,
      'image/webp',
    );

    expect(signed.uploadUrl).toBe(absolute);
  });

  it('reports an expiry the caller can compare against a clock', async () => {
    const seen: Seen[] = [];
    const before = Date.now();
    const signed = await client(responder(200, { url: '/object/x?token=abc' }, seen)).signUpload(
      'seller-media',
      PATH,
      'image/webp',
    );

    expect(signed.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(signed.expiresAt.getTime()).toBeLessThan(before + 130_000);
  });

  it.each([
    ['a body with no URL at all', {}],
    ['a body whose URL is empty', { url: '' }],
    ['a body whose URL is not a string', { url: 42 }],
    ['a body that is not an object', 'just text'],
    ['a null body', null],
    ['an array', []],
  ])('fails closed on %s', async (_name, payload) => {
    const seen: Seen[] = [];
    await expect(
      client(responder(200, payload, seen)).signUpload('seller-media', PATH, 'image/webp'),
    ).rejects.toBeInstanceOf(SellerMediaStorageUnavailableError);
  });

  it('fails closed on an unparsable body', async () => {
    const fetchImpl = (async () =>
      new Response('<html>nope</html>', { status: 200 })) as unknown as typeof fetch;

    await expect(
      client(fetchImpl).signUpload('seller-media', PATH, 'image/webp'),
    ).rejects.toBeInstanceOf(SellerMediaStorageUnavailableError);
  });

  it.each([400, 401, 403, 404, 409, 429, 500, 502, 503])('fails closed on a %i', async (status) => {
    const seen: Seen[] = [];
    await expect(
      client(responder(status, { error: 'nope' }, seen)).signUpload('seller-media', PATH, 'image/webp'),
    ).rejects.toBeInstanceOf(SellerMediaStorageUnavailableError);
  });

  it('fails closed when the provider cannot be reached', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    await expect(
      client(fetchImpl).signUpload('seller-media', PATH, 'image/webp'),
    ).rejects.toBeInstanceOf(SellerMediaStorageUnavailableError);
  });

  it('abandons a hung provider rather than hanging the request', async () => {
    const fetchImpl = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const hung = new SupabaseStorageClient({ ...CONFIG, fetch: fetchImpl, timeoutMs: 10 });

    await expect(hung.signUpload('seller-media', PATH, 'image/webp')).rejects.toBeInstanceOf(
      SellerMediaStorageUnavailableError,
    );
  });

  it('carries the request under an abort signal, so the timeout can actually fire', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response(JSON.stringify({ url: '/object/x?token=abc' }), { status: 200 });
    }) as unknown as typeof fetch;

    await client(fetchImpl).signUpload('seller-media', PATH, 'image/webp');
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('checking whether an object is there', () => {
  it('asks about the exact object, with the key in headers only', async () => {
    const seen: Seen[] = [];
    const exists = await client(responder(200, { name: 'x' }, seen)).objectExists('seller-media', PATH);

    expect(exists).toBe(true);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toContain(PATH);
    expect(seen[0]?.url).not.toContain(CONFIG.secretKey);
    expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${CONFIG.secretKey}`);
  });

  it('reads a 404 as "not there", which is an answer rather than a failure', async () => {
    const seen: Seen[] = [];
    const exists = await client(responder(404, { error: 'not found' }, seen)).objectExists(
      'seller-media',
      PATH,
    );

    expect(exists).toBe(false);
  });

  it.each([400, 401, 403, 500, 502, 503])('fails closed on a %i', async (status) => {
    const seen: Seen[] = [];
    await expect(
      client(responder(status, { error: 'nope' }, seen)).objectExists('seller-media', PATH),
    ).rejects.toBeInstanceOf(SellerMediaStorageUnavailableError);
  });

  it('fails closed when the provider cannot be reached', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).objectExists('seller-media', PATH)).rejects.toBeInstanceOf(
      SellerMediaStorageUnavailableError,
    );
  });

  it('accepts any 2xx as "there", without needing to understand the body', async () => {
    const seen: Seen[] = [];
    expect(await client(responder(200, 'not json at all', seen)).objectExists('seller-media', PATH)).toBe(true);
  });
});

describe('what the adapter never does', () => {
  it('composes no object path of its own', async () => {
    const seen: Seen[] = [];
    const odd = 'seller-media/a-shop/banner/22222222-2222-2222-2222-222222222222.png';
    await client(responder(200, { url: '/object/x?token=abc' }, seen)).signUpload(
      'seller-media',
      odd,
      'image/png',
    );

    // Exactly what it was handed, nothing normalised, nothing appended.
    expect(seen[0]?.url).toBe(
      `${CONFIG.url}/storage/v1/object/upload/sign/seller-media/${odd}`,
    );
  });

  it('encodes a segment that would otherwise change the URL', async () => {
    const seen: Seen[] = [];
    // The database cannot produce such a path; the adapter still must not let one alter the request shape.
    await client(responder(200, { url: '/object/x?token=abc' }, seen)).signUpload(
      'seller-media',
      'seller-media/a shop/logo/x?y=z.webp',
      'image/webp',
    );

    expect(seen[0]?.url).toContain('a%20shop');
    expect(seen[0]?.url).toContain('x%3Fy%3Dz.webp');
    // The query separator the encoded name would have introduced is not there.
    expect(seen[0]?.url.split('?')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------------ */

/**
 * Signing a read (Phase 7-G).
 *
 * The third call on the same port, added for the reviewer surface. The properties asserted are the same
 * ones the upload signing has, for the same reasons: the key is in headers and nowhere else, the path is
 * used exactly as the database composed it, an answer this client does not understand fails closed, and
 * nothing that could carry a path or a key is logged or returned beyond the URL itself.
 *
 * As with the other two, the endpoint's spelling is provider behaviour and is named in the increment
 * report as a Final QA item rather than asserted from memory here.
 */
const VERIFICATION_PATH =
  'verification-documents/good-shop/national_id/22222222-2222-4222-8222-222222222222.jpg';

describe('signing a read', () => {
  it('presents the project key in headers, and nowhere else', async () => {
    const seen: Seen[] = [];
    await client(responder(200, { url: '/object/sign/verification-documents/x?token=abc' }, seen)).signDownload(
      'verification-documents',
      VERIFICATION_PATH,
    );

    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.headers.get('apikey')).toBe(CONFIG.secretKey);
    expect(seen[0]!.headers.get('authorization')).toBe(`Bearer ${CONFIG.secretKey}`);
    expect(seen[0]!.url).not.toContain(CONFIG.secretKey);
    expect(seen[0]!.body ?? '').not.toContain(CONFIG.secretKey);
  });

  it('uses the path the database composed, segment-encoded, separators intact', async () => {
    const seen: Seen[] = [];
    await client(responder(200, { url: '/object/sign/verification-documents/x?token=abc' }, seen)).signDownload(
      'verification-documents',
      VERIFICATION_PATH,
    );

    expect(seen[0]!.url).toContain(VERIFICATION_PATH);
    expect(seen[0]!.url.split('?')[0]).toMatch(/\/verification-documents\/verification-documents\//);
  });

  it('asks for a bounded lifetime and sends nothing else', async () => {
    const seen: Seen[] = [];
    await client(responder(200, { url: '/object/sign/verification-documents/x?token=abc' }, seen)).signDownload(
      'verification-documents',
      VERIFICATION_PATH,
    );

    expect(JSON.parse(seen[0]!.body ?? '{}')).toEqual({ expiresIn: 120 });
  });

  it('accepts a relative URL and resolves it against the storage base', async () => {
    const seen: Seen[] = [];
    const signed = await client(
      responder(200, { signedURL: '/object/sign/verification-documents/x?token=abc' }, seen),
    ).signDownload('verification-documents', VERIFICATION_PATH);

    expect(signed.url).toBe(
      'https://project.supabase.invalid/storage/v1/object/sign/verification-documents/x?token=abc',
    );
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts an absolute URL unchanged, under any of the spellings', async () => {
    for (const field of ['url', 'signedUrl', 'signedURL']) {
      const seen: Seen[] = [];
      const signed = await client(
        responder(200, { [field]: 'https://cdn.supabase.invalid/one.jpg?token=abc' }, seen),
      ).signDownload('verification-documents', VERIFICATION_PATH);
      expect(signed.url, field).toBe('https://cdn.supabase.invalid/one.jpg?token=abc');
    }
  });

  it('fails closed on anything it does not understand', async () => {
    const cases: Array<[string, typeof fetch]> = [
      ['a body with no URL', responder(200, { ok: true }, [])],
      ['a body that is not JSON', responder(200, 'not json', [])],
      ['an empty URL', responder(200, { url: '   ' }, [])],
      ['a 404', responder(404, {}, [])],
      ['a 500', responder(500, {}, [])],
      [
        'an unreachable host',
        (async () => {
          throw new Error('connect ECONNREFUSED');
        }) as unknown as typeof fetch,
      ],
    ];

    for (const [name, fetchImpl] of cases) {
      await expect(
        client(fetchImpl).signDownload('verification-documents', VERIFICATION_PATH),
        name,
      ).rejects.toBeInstanceOf(SellerMediaStorageUnavailableError);
    }
  });
});
