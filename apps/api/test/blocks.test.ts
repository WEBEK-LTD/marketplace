import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUYER_ACCOUNT_STORE,
  type BlockRow,
} from '../src/account/buyer-account.service.js';
import {
  encodeBlockReference,
  encodeBlocksCursor,
  encodeFavoritesCursor,
  encodeSavedSearchesCursor,
} from '../src/account/account-cursor.js';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Blocking at the API boundary (0103).
 *
 * The database decides who may be blocked and whose blocks may be removed; this layer decides what crosses
 * the boundary. So the assertions here are about identifiers and about indistinguishable answers:
 *
 *   * **the account identifier the store returns never reaches a response** — the list is checked field by
 *     field and then the whole response body is searched for it;
 *   * **no request can name an account** — in a body, a query string or a path;
 *   * **one handle per request**, and both-at-once is a 400 rather than a resolved precedence;
 *   * **a reference the API cannot read is not a distinct refusal** — it reports that nothing changed,
 *     exactly as a reference for a block that was never there, and the two are checked to be byte-identical;
 *   * **a reference from another list is spent on nothing** — the store is still given the caller's own
 *     account, so the scope is the database's and not this layer's.
 */

const SESSION_TOKEN = 'caller-access-token-value-not-a-real-token';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const BLOCKED_A = '22222222-2222-4222-8222-222222222222';
const BLOCKED_B = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const CREATED = new Date('2026-10-03T10:00:00.000Z');
const EARLIER = new Date('2026-10-01T10:00:00.000Z');

function blockRow(blockedUserId: string, overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    blockedUserId,
    displayName: 'Sally Seller',
    sellerSlug: 'good-shop',
    reason: 'rude',
    createdAt: CREATED,
    ...overrides,
  };
}

interface Recorded {
  readonly calls: string[];
  readonly args: Array<Record<string, unknown>>;
}

interface Doubles {
  readonly blocks?: BlockRow[];
  readonly blockAdd?: 'blocked' | 'exists' | 'not_found';
  readonly blockRemove?: boolean;
  readonly throws?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], args: [] };
  const record = <T>(name: string, input: unknown, value: T): T => {
    recorded.calls.push(name);
    recorded.args.push(
      (typeof input === 'object' && input !== null ? input : { input }) as Record<string, unknown>,
    );
    if (doubles.throws === true) throw new Error('database unavailable');
    return value;
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({ getUser: async () => ({ id: USER, phone: null }) })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Amina' }) })
    .overrideProvider(BUYER_ACCOUNT_STORE)
    .useValue({
      buyerBlocks: async (input: unknown) => record('blocks', input, doubles.blocks ?? []),
      buyerBlockAdd: async (input: unknown) => record('block-add', input, doubles.blockAdd ?? 'blocked'),
      buyerBlockRemove: async (input: unknown) =>
        record('block-remove', input, doubles.blockRemove ?? true),
      // The rest of 7-E, present so the module composes. Nothing below calls them.
      buyerFavorites: async () => [],
      buyerFavoriteAdd: async () => 'added',
      buyerFavoriteRemove: async () => true,
      buyerSavedSearches: async () => [],
      buyerSavedSearchCreate: async () => ({ outcome: 'created', id: BLOCKED_A }),
      buyerSavedSearchUpdate: async () => 'updated',
      buyerSavedSearchDelete: async () => true,
      buyerAddresses: async () => [],
      buyerAddressCreate: async () => ({ outcome: 'created', id: BLOCKED_A }),
      buyerAddressUpdate: async () => 'updated',
      buyerAddressDelete: async () => true,
      buyerProfile: async () => null,
      buyerProfileUpdate: async () => 'updated',
      buyerSettings: async () => null,
      buyerSettingsUpdate: async () => true,
      referenceCountries: async () => [],
    })
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return recorded;
}

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  payload?: unknown,
  headers: Record<string, string | null> = {},
): Promise<Result> {
  const base: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
    [SESSION_TOKEN_HEADER]: SESSION_TOKEN,
  };
  if (payload !== undefined) base['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete base[name];
    else base[name] = value;
  }
  const response = await app!.inject({
    method,
    url: `/v1${path}`,
    headers: base,
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/users/me/blocks', () => {
  it('names each person by display name and storefront, and by nothing else', async () => {
    await start({ blocks: [blockRow(BLOCKED_A)] });
    const result = await call('GET', '/users/me/blocks');

    expect(result.status).toBe(200);
    const items = result.body['items'] as Array<Record<string, unknown>>;
    expect(Object.keys(items[0]!).sort()).toEqual([
      'blockedAt',
      'displayName',
      'reason',
      'reference',
      'sellerSlug',
    ]);
    expect(items[0]!['displayName']).toBe('Sally Seller');
    expect(items[0]!['sellerSlug']).toBe('good-shop');
    expect(items[0]!['blockedAt']).toBe('2026-10-03T10:00:00.000Z');
  });

  /** The assertion the whole design exists for, made against the whole body rather than a field list. */
  it('never puts the blocked account identifier anywhere in the response', async () => {
    await start({ blocks: [blockRow(BLOCKED_A), blockRow(BLOCKED_B, { createdAt: EARLIER })] });
    const result = await call('GET', '/users/me/blocks');

    expect(result.raw).not.toContain(BLOCKED_A);
    expect(result.raw).not.toContain(BLOCKED_B);
    expect(result.raw).not.toContain(USER);
  });

  it('carries an opaque reference per row, different for different people', async () => {
    await start({ blocks: [blockRow(BLOCKED_A), blockRow(BLOCKED_B, { createdAt: EARLIER })] });
    const items = (await call('GET', '/users/me/blocks')).body['items'] as Array<Record<string, unknown>>;

    expect(items[0]!['reference']).not.toBe(items[1]!['reference']);
    for (const item of items) {
      expect(item['reference']).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('renders somebody with no name, no storefront and no reason without inventing one', async () => {
    await start({
      blocks: [blockRow(BLOCKED_A, { displayName: null, sellerSlug: null, reason: null })],
    });
    const items = (await call('GET', '/users/me/blocks')).body['items'] as Array<Record<string, unknown>>;

    expect(items[0]!['displayName']).toBeNull();
    expect(items[0]!['sellerSlug']).toBeNull();
    expect(items[0]!['reason']).toBeNull();
    expect(items[0]!['reference']).toEqual(expect.any(String));
  });

  it('is an empty page, not a 404, for somebody who has blocked nobody', async () => {
    await start({ blocks: [] });
    const result = await call('GET', '/users/me/blocks');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ items: [], nextCursor: null });
  });

  it('asks for one more row than the page size, and reports a cursor only when there is one', async () => {
    const recorded = await start({ blocks: [blockRow(BLOCKED_A)] });
    const result = await call('GET', '/users/me/blocks?limit=1');

    expect(recorded.args[0]!['limit']).toBe(2);
    expect(result.body['nextCursor']).toBeNull();
  });

  it('reports a cursor when a further page exists, built from the last row it returns', async () => {
    await start({ blocks: [blockRow(BLOCKED_A), blockRow(BLOCKED_B, { createdAt: EARLIER })] });
    const result = await call('GET', '/users/me/blocks?limit=1');

    expect((result.body['items'] as unknown[]).length).toBe(1);
    expect(result.body['nextCursor']).toBe(encodeBlocksCursor({ createdAt: CREATED, id: BLOCKED_A }));
  });

  it('does not leak the account identifier through the cursor it issues', async () => {
    await start({ blocks: [blockRow(BLOCKED_A), blockRow(BLOCKED_B, { createdAt: EARLIER })] });
    const result = await call('GET', '/users/me/blocks?limit=1');
    // The cursor encodes the row position, which includes the account — so the test is that the raw body
    // contains no readable form of it, which is what an opaque encoding is for.
    expect(result.raw).not.toContain(BLOCKED_A);
  });

  it('passes a cursor it issued back to the store as a position', async () => {
    const cursor = encodeBlocksCursor({ createdAt: CREATED, id: BLOCKED_A });
    const recorded = await start({ blocks: [] });
    await call('GET', `/users/me/blocks?cursor=${encodeURIComponent(cursor)}`);

    expect(recorded.args[0]!['cursorCreatedAt']).toEqual(CREATED);
    expect(recorded.args[0]!['cursorBlockedId']).toBe(BLOCKED_A);
  });

  it('refuses a cursor it cannot read, before reaching the store', async () => {
    for (const cursor of ['nonsense', 'a b', '!!!!', encodeBlocksCursor({ createdAt: CREATED, id: BLOCKED_A }).slice(0, -3)]) {
      const recorded = await start();
      const result = await call('GET', `/users/me/blocks?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code']).toBe('ACCOUNT_CURSOR_INVALID');
      expect(recorded.calls, cursor).toEqual([]);
      await app?.close();
      app = undefined;
    }
  });

  /** Versioned per list, so one list's position cannot be spent on another's. */
  it('refuses a favorites or saved-search cursor', async () => {
    for (const cursor of [
      encodeFavoritesCursor({ createdAt: CREATED, id: BLOCKED_A }),
      encodeSavedSearchesCursor({ createdAt: CREATED, id: BLOCKED_A }),
    ]) {
      await start();
      const result = await call('GET', `/users/me/blocks?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code']).toBe('ACCOUNT_CURSOR_INVALID');
      await app?.close();
      app = undefined;
    }
  });

  it('refuses a block reference used as a cursor', async () => {
    await start();
    const result = await call(
      'GET',
      `/users/me/blocks?cursor=${encodeURIComponent(encodeBlockReference(BLOCKED_A))}`,
    );
    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('ACCOUNT_CURSOR_INVALID');
  });

  it('clamps the page size to the account ceiling', async () => {
    const recorded = await start();
    await call('GET', '/users/me/blocks?limit=50');
    expect(recorded.args[0]!['limit']).toBe(51);

    await call('GET', '/users/me/blocks?limit=9999');
    expect(recorded.args[1]!['limit']).toBe(51);
  });

  it('refuses a page size that is not a number at all', async () => {
    await start();
    expect((await call('GET', '/users/me/blocks?limit=lots')).status).toBe(400);
    expect((await call('GET', '/users/me/blocks?limit=-1')).status).toBe(400);
  });

  it('answers 503 rather than an empty list when the store cannot be reached', async () => {
    await start({ throws: true });
    const result = await call('GET', '/users/me/blocks');
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('database unavailable');
  });
});

describe('POST /v1/users/me/blocks', () => {
  it('passes a conversation through as the only handle', async () => {
    const recorded = await start({ blockAdd: 'blocked' });
    const result = await call('POST', '/users/me/blocks', { conversationId: CONVERSATION });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changed: true });
    expect(recorded.args.at(-1)).toEqual({
      userId: USER,
      conversationId: CONVERSATION,
      sellerSlug: null,
      reason: null,
    });
  });

  it('passes a seller slug through as the only handle', async () => {
    const recorded = await start({ blockAdd: 'blocked' });
    await call('POST', '/users/me/blocks', { sellerSlug: 'good-shop', reason: '  rude  ' });

    expect(recorded.args.at(-1)).toEqual({
      userId: USER,
      conversationId: null,
      sellerSlug: 'good-shop',
      reason: 'rude',
    });
  });

  it('refuses a body carrying both handles rather than choosing one', async () => {
    const recorded = await start();
    const result = await call('POST', '/users/me/blocks', {
      conversationId: CONVERSATION,
      sellerSlug: 'good-shop',
    });

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.calls).not.toContain('block-add');
  });

  it('refuses a body carrying neither', async () => {
    await start();
    expect((await call('POST', '/users/me/blocks', {})).status).toBe(400);
    expect((await call('POST', '/users/me/blocks', { reason: 'rude' })).status).toBe(400);
  });

  it('refuses a body that names an account, under any field name', async () => {
    const recorded = await start();
    for (const extra of [
      { userId: OTHER_USER },
      { blockedUserId: OTHER_USER },
      { blockedId: OTHER_USER },
    ]) {
      const result = await call('POST', '/users/me/blocks', { sellerSlug: 'good-shop', ...extra });
      expect(result.status, JSON.stringify(extra)).toBe(400);
    }
    expect(recorded.calls).not.toContain('block-add');
  });

  it('refuses a bare account identifier as the whole body', async () => {
    await start();
    expect((await call('POST', '/users/me/blocks', { blockedUserId: OTHER_USER })).status).toBe(400);
  });

  it('reports that nothing changed for somebody already blocked, and still succeeds', async () => {
    await start({ blockAdd: 'exists' });
    const result = await call('POST', '/users/me/blocks', { sellerSlug: 'good-shop' });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changed: false });
  });

  it('answers 404 for every handle the database could not resolve', async () => {
    await start({ blockAdd: 'not_found' });
    for (const body of [{ sellerSlug: 'nobody' }, { conversationId: CONVERSATION }]) {
      const result = await call('POST', '/users/me/blocks', body);
      expect(result.status, JSON.stringify(body)).toBe(404);
      expect(result.body['code']).toBe('NOT_FOUND');
    }
  });

  /** One wording for five different situations, so none of them can be told from another. */
  it('says nothing about which handle failed', async () => {
    await start({ blockAdd: 'not_found' });
    const slug = await call('POST', '/users/me/blocks', { sellerSlug: 'nobody' });
    const conversation = await call('POST', '/users/me/blocks', { conversationId: CONVERSATION });

    expect(slug.raw).toBe(conversation.raw);
    expect(slug.raw).not.toContain('nobody');
    expect(slug.raw).not.toContain('conversation');
    expect(slug.raw).not.toContain('slug');
  });

  /**
   * No step-up. An ordinary session is enough, which is the decision rather than an oversight: a second
   * factor between somebody and the button that stops harassment would be the wrong trade, and nothing this
   * route can reach is privileged.
   */
  it('succeeds on an ordinary session, with no step-up header of any kind', async () => {
    const recorded = await start({ blockAdd: 'blocked' });
    const result = await call('POST', '/users/me/blocks', { sellerSlug: 'good-shop' });

    expect(result.status).toBe(200);
    expect(recorded.calls).toContain('block-add');
    for (const args of recorded.args) {
      expect(Object.keys(args)).not.toContain('isAal2');
      expect(Object.keys(args)).not.toContain('aal');
    }
  });
});

describe('DELETE /v1/users/me/blocks/{reference}', () => {
  it('removes the block the reference names, scoped to the caller', async () => {
    const recorded = await start({ blockRemove: true });
    const result = await call('DELETE', `/users/me/blocks/${encodeBlockReference(BLOCKED_A)}`);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changed: true });
    expect(recorded.args.at(-1)).toEqual({ userId: USER, blockedUserId: BLOCKED_A });
  });

  it('reports that nothing changed for a block that was not there', async () => {
    await start({ blockRemove: false });
    const result = await call('DELETE', `/users/me/blocks/${encodeBlockReference(BLOCKED_A)}`);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changed: false });
  });

  /** The property that stops references being probed: unreadable and unmatched answer identically. */
  it('answers a reference it cannot read exactly as it answers an unmatched one', async () => {
    const recorded = await start({ blockRemove: false });
    const unreadable = await call('DELETE', '/users/me/blocks/bm90LWEtcmVmZXJlbmNl');
    const unmatched = await call('DELETE', `/users/me/blocks/${encodeBlockReference(BLOCKED_A)}`);

    expect(unreadable.status).toBe(unmatched.status);
    expect(unreadable.raw).toBe(unmatched.raw);
    // And the unreadable one never reached the store at all, so it could not even be timed apart by a query.
    expect(recorded.calls.filter((name) => name === 'block-remove').length).toBe(1);
  });

  it('refuses a cursor used as a reference, by reporting that nothing changed', async () => {
    const recorded = await start();
    const result = await call(
      'DELETE',
      `/users/me/blocks/${encodeBlocksCursor({ createdAt: CREATED, id: BLOCKED_A })}`,
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changed: false });
    expect(recorded.calls).not.toContain('block-remove');
  });

  it('never passes an account the request named to the store', async () => {
    const recorded = await start({ blockRemove: true });
    // A reference minted over somebody else's account still only ever removes the caller's own row, because
    // `userId` is the token's and the database's predicate carries it.
    await call('DELETE', `/users/me/blocks/${encodeBlockReference(OTHER_USER)}`);

    expect(recorded.args.at(-1)!['userId']).toBe(USER);
    expect(recorded.args.at(-1)!['blockedUserId']).toBe(OTHER_USER);
  });

  it('answers 503 when the store cannot be reached', async () => {
    await start({ throws: true });
    const result = await call('DELETE', `/users/me/blocks/${encodeBlockReference(BLOCKED_A)}`);
    expect(result.status).toBe(503);
  });
});

describe('the surface as a whole', () => {
  /**
   * There is no route that answers who blocked the caller, and none that lets staff look.
   *
   * Asserted as "not a success, and carries no block data", rather than as a bare 404: some of these paths
   * fall into an existing admin prefix that validates its own parameters and refuses with a 400 before it
   * decides there is no such route. Either way nothing answered, and what matters is that nothing answered
   * **with a list**.
   */
  it('offers no reverse lookup and no staff view', async () => {
    const recorded = await start({ blocks: [blockRow(BLOCKED_A)] });
    for (const path of [
      '/users/me/blocked-by',
      '/users/me/blockers',
      '/admin/blocks',
      '/admin/users/blocks',
      `/users/${OTHER_USER}/blocks`,
    ]) {
      const result = await call('GET', path);
      expect(result.status, path).not.toBe(200);
      expect(result.raw, path).not.toContain('Sally Seller');
      expect(result.raw, path).not.toContain(BLOCKED_A);
    }
    expect(recorded.calls).not.toContain('blocks');
  });

  it('offers no way to block through an account identifier in the path', async () => {
    await start();
    const result = await call('POST', `/users/me/blocks/${OTHER_USER}`);
    expect(result.status).toBe(404);
  });

  /** The controller's own source: no permission, no assurance level, no account parameter. */
  it('decides nothing about authority in the controller', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'v1', 'buyer-account.controller.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toContain('isAal2');
    expect(code).not.toContain('requiresMfa');
    expect(code).not.toContain('permission');
    expect(code).not.toMatch(/@Param\('userId'\)/);
  });

  /** The service's own source: the reference is decoded in one place and nothing else parses it. */
  it('decodes a block reference in exactly one place', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'account', 'buyer-account.service.ts'),
      'utf8',
    );
    expect(source.match(/decodeBlockReference/g)?.length).toBe(2); // the import and the one call
  });
});
