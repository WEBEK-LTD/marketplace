import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleAddBlock, handleRemoveBlock, readBlocks } from '../src/server/bff/buyer-account';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The BFF half of blocking (0103).
 *
 * What matters at this boundary:
 *
 *   * **the body is rebuilt from the contract union**, so exactly one handle leaves this origin and a page
 *     that added an account identifier has it refused here, before the hop — the API's strict schema would
 *     refuse it too, and neither wall relies on the other;
 *   * **the reference is carried, not understood** — it is checked for being safe in a URL and nothing else,
 *     because a BFF that decoded it would be a second place that has to agree about the format;
 *   * **no account identifier reaches a browser**, asserted on the whole response text;
 *   * a cross-site write is refused before the session is read, and an ended session before the hop;
 *   * **nothing here logs**, because every value passing through names a person.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-blocks-credential-value-not-a-real-set',
});

const SESSION_TOKEN = 'session-token-canary-value-not-a-real-token';
const COOKIE = `${SESSION_COOKIES.access.name}=${SESSION_TOKEN}`;
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const REFERENCE = 'YnIxfDIyMjIyMjIyLTIyMjItNDIyMi04MjIyLTIyMjIyMjIyMjIyMg';

const PERSON = {
  reference: REFERENCE,
  displayName: 'Sally Seller',
  sellerSlug: 'good-shop',
  reason: 'rude',
  blockedAt: '2026-10-03T10:00:00.000Z',
};

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({
      url: String(input),
      method: String(init.method ?? 'GET'),
      headers: new Headers(init.headers),
      body: String(init.body ?? ''),
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

const unreachable = (async () => {
  throw new Error('the API is unreachable');
}) as unknown as typeof fetch;

function write(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://web.test/api/account/${path}`, {
    method,
    headers: {
      origin: 'https://web.test',
      cookie: COOKIE,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/* ------------------------------------------------------------------------------------------------ */

describe('reading the block list', () => {
  it('presents the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readBlocks({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/users/me/blocks');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('returns the validated page', async () => {
    const result = await readBlocks(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [PERSON], nextCursor: null }) },
    );
    expect(result).toEqual({ kind: 'ok', data: { items: [PERSON], nextCursor: null } });
  });

  it('passes a cursor through verbatim and parses nothing', async () => {
    const seen: Seen[] = [];
    await readBlocks(
      { cursor: 'YmwxfDIwMjYtMTAtMDN8YWJj', limit: '10' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).toContain('cursor=YmwxfDIwMjYtMTAtMDN8YWJj');
    expect(seen[0]!.url).toContain('limit=10');
  });

  /** A drifted API is a clean failure here, not a page that renders a field nobody approved. */
  it('refuses a page carrying an account identifier', async () => {
    for (const extra of [
      { blockedUserId: OTHER_USER },
      { userId: OTHER_USER },
      { blockedId: OTHER_USER },
      { email: 'someone@example.test' },
    ]) {
      const result = await readBlocks(
        {},
        {
          env: ENV,
          cookieHeader: COOKIE,
          fetch: api(200, { items: [{ ...PERSON, ...extra }], nextCursor: null }),
        },
      );
      expect(result.kind, JSON.stringify(extra)).toBe('unavailable');
    }
  });

  it('refuses a page carrying a reverse-lookup field or a total', async () => {
    for (const payload of [
      { items: [{ ...PERSON, blockedMeBack: true }], nextCursor: null },
      { items: [PERSON], nextCursor: null, total: 1 },
      { items: [PERSON], nextCursor: null, blockedBy: [] },
    ]) {
      const result = await readBlocks({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, payload) });
      expect(result.kind, JSON.stringify(payload)).toBe('unavailable');
    }
  });

  it('accepts somebody with no name and no storefront', async () => {
    const result = await readBlocks(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, {
          items: [{ ...PERSON, displayName: null, sellerSlug: null, reason: null }],
          nextCursor: null,
        }),
      },
    );
    expect(result.kind).toBe('ok');
  });

  it('reports an ended session, an unusable cursor and an outage apart from one another', async () => {
    const ended = await readBlocks({}, { env: ENV, cookieHeader: null, fetch: api(200, {}) });
    expect(ended).toEqual({ kind: 'unauthenticated' });

    const refused = await readBlocks(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(400, { code: 'ACCOUNT_CURSOR_INVALID' }) },
    );
    expect(refused.kind).toBe('invalid');

    const down = await readBlocks({}, { env: ENV, cookieHeader: COOKIE, fetch: unreachable });
    expect(down.kind).toBe('unavailable');
  });

  it('is an empty page for somebody who has blocked nobody, not an error', async () => {
    const result = await readBlocks(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }) },
    );
    expect(result).toEqual({ kind: 'ok', data: { items: [], nextCursor: null } });
  });
});

describe('creating a block', () => {
  it('sends a conversation handle on its own, as a body it assembled', async () => {
    const seen: Seen[] = [];
    const response = await handleAddBlock(write('POST', 'blocks', { conversationId: CONVERSATION }), {
      env: ENV,
      fetch: api(200, { changed: true }, seen),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: true });
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/users/me/blocks');
    expect(JSON.parse(seen[0]!.body)).toEqual({ conversationId: CONVERSATION, reason: null });
  });

  it('sends a seller slug on its own, with the reason trimmed', async () => {
    const seen: Seen[] = [];
    await handleAddBlock(write('POST', 'blocks', { sellerSlug: 'good-shop', reason: '  rude  ' }), {
      env: ENV,
      fetch: api(200, { changed: true }, seen),
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({ sellerSlug: 'good-shop', reason: 'rude' });
  });

  it('refuses a body carrying both handles, before the hop', async () => {
    const seen: Seen[] = [];
    const response = await handleAddBlock(
      write('POST', 'blocks', { conversationId: CONVERSATION, sellerSlug: 'good-shop' }),
      { env: ENV, fetch: api(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('refuses a body carrying neither', async () => {
    const seen: Seen[] = [];
    expect((await handleAddBlock(write('POST', 'blocks', {}), { env: ENV, fetch: api(200, {}, seen) })).status).toBe(400);
    expect(seen).toEqual([]);
  });

  /** The wall this layer owns: a page that added an account identifier never reaches the API with one. */
  it('refuses a body that names an account, rather than dropping the field', async () => {
    const seen: Seen[] = [];
    for (const extra of [{ userId: OTHER_USER }, { blockedUserId: OTHER_USER }, { blockedId: OTHER_USER }]) {
      const response = await handleAddBlock(write('POST', 'blocks', { sellerSlug: 'good-shop', ...extra }), {
        env: ENV,
        fetch: api(200, { changed: true }, seen),
      });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it('refuses a cross-site write before reading the session', async () => {
    const seen: Seen[] = [];
    const response = await handleAddBlock(
      write('POST', 'blocks', { sellerSlug: 'good-shop' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: api(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('refuses a write with no session, before the hop', async () => {
    const seen: Seen[] = [];
    const request = new Request('https://web.test/api/account/blocks', {
      method: 'POST',
      headers: { origin: 'https://web.test', 'content-type': 'application/json' },
      body: JSON.stringify({ sellerSlug: 'good-shop' }),
    });
    const response = await handleAddBlock(request, { env: ENV, fetch: api(200, {}, seen) });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('forwards the API’s 404 with its own problem body, so a page can say it did not work', async () => {
    const response = await handleAddBlock(write('POST', 'blocks', { sellerSlug: 'nobody' }), {
      env: ENV,
      fetch: api(404, { code: 'NOT_FOUND', status: 404 }),
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('reports an unexpected upstream status as the generic outage', async () => {
    for (const status of [418, 500, 502]) {
      const response = await handleAddBlock(write('POST', 'blocks', { sellerSlug: 'good-shop' }), {
        env: ENV,
        fetch: api(status, { code: 'SOMETHING' }),
      });
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('refuses a success body that has drifted', async () => {
    const response = await handleAddBlock(write('POST', 'blocks', { sellerSlug: 'good-shop' }), {
      env: ENV,
      fetch: api(200, { changed: true, blockedUserId: OTHER_USER }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(OTHER_USER);
  });
});

describe('removing a block', () => {
  it('carries the reference into the upstream path exactly as given', async () => {
    const seen: Seen[] = [];
    const response = await handleRemoveBlock(write('DELETE', `blocks/${REFERENCE}`), REFERENCE, {
      env: ENV,
      fetch: api(200, { changed: true }, seen),
    });

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/users/me/blocks/${REFERENCE}`);
    expect(seen[0]!.method).toBe('DELETE');
  });

  /** base64url is case-significant, so lowering it the way an identifier is lowered would break it. */
  it('preserves the reference’s case', async () => {
    const mixed = 'YnIxfEFiQ2REZQ';
    const seen: Seen[] = [];
    await handleRemoveBlock(write('DELETE', `blocks/${mixed}`), mixed, {
      env: ENV,
      fetch: api(200, { changed: true }, seen),
    });
    expect(seen[0]!.url).toContain(mixed);
  });

  it('refuses a reference that could not sit in a URL path, before the hop', async () => {
    const seen: Seen[] = [];
    for (const reference of ['', 'a b', '../../etc/passwd', "' or 1=1--", 'x'.repeat(513), 'YnIx=']) {
      const response = await handleRemoveBlock(write('DELETE', 'blocks/x'), reference, {
        env: ENV,
        fetch: api(200, { changed: true }, seen),
      });
      expect(response.status, JSON.stringify(reference)).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it('refuses a cross-site unblock', async () => {
    const seen: Seen[] = [];
    const response = await handleRemoveBlock(
      write('DELETE', `blocks/${REFERENCE}`, undefined, { origin: 'https://evil.test' }),
      REFERENCE,
      { env: ENV, fetch: api(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('reports that nothing changed without treating it as a failure', async () => {
    const response = await handleRemoveBlock(write('DELETE', `blocks/${REFERENCE}`), REFERENCE, {
      env: ENV,
      fetch: api(200, { changed: false }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: false });
  });

  it('sends no body at all', async () => {
    const seen: Seen[] = [];
    await handleRemoveBlock(write('DELETE', `blocks/${REFERENCE}`), REFERENCE, {
      env: ENV,
      fetch: api(200, { changed: true }, seen),
    });
    expect(seen[0]!.body).toBe('');
    expect(seen[0]!.headers.get('content-type')).toBeNull();
  });
});

describe('the module’s own shape', () => {
  const SOURCE = readFileSync(
    join(import.meta.dirname, '..', 'src', 'server', 'bff', 'buyer-account.ts'),
    'utf8',
  );
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /** The one place a block reference could be misunderstood is here, so it is asserted not to try. */
  it('never decodes a reference or a cursor', () => {
    expect(CODE).not.toContain('base64url');
    expect(CODE).not.toContain('decodeBlockReference');
    expect(CODE).not.toContain('decodeBlocksCursor');
    expect(CODE).not.toContain('Buffer.from');
  });

  it('logs nothing, because every value passing through names a person', () => {
    expect(CODE).not.toContain('console.');
    expect(CODE).not.toContain('logger');
  });

  it('exports no reverse lookup', () => {
    for (const name of ['readBlockedBy', 'readBlockers', 'handleStaffBlock', 'readBlockCount']) {
      expect(CODE, name).not.toContain(name);
    }
  });
});
