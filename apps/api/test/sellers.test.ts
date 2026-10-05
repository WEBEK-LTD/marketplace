import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SellerProfileResponseSchema } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { SELLER_STORE, type SellerProfileRow } from '../src/catalog/sellers.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `GET /v1/sellers/:slug` (Phase 4-E).
 *
 * The database decides which sellers have a public page; these tests are about the boundary above it —
 * the two statuses, the availability marker that distinguishes a suspended seller from a live one, and
 * the fact that nothing outside the approved projection can reach a response.
 */

const ACTIVE: SellerProfileRow = {
  outcome: 'found',
  availability: 'available',
  slug: 'good-shop',
  displayName: 'Good Shop',
  bio: 'We restore mid-century furniture.',
  contentLanguage: 'en',
  city: 'Cairo',
};

type Double = Pick<SellerProfileRow, 'outcome'> & Partial<SellerProfileRow>;

interface Recorded {
  readonly slugs: string[];
}

let app: NestFastifyApplication | undefined;

async function start(row: Double | 'throws' = ACTIVE): Promise<Recorded> {
  const recorded: Recorded = { slugs: [] };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SELLER_STORE)
    .useValue({
      publicSellerBySlug: async (slug: string) => {
        recorded.slugs.push(slug);
        if (row === 'throws') throw new Error('the catalogue is unreachable');
        return row;
      },
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

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function get(path: string): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await app!.inject({
    method: 'GET',
    url: path,
    headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
  });
  return {
    status: response.statusCode,
    body: response.payload === '' ? {} : (JSON.parse(response.payload) as Record<string, unknown>),
    raw: response.payload,
  };
}

describe('GET /v1/sellers/:slug', () => {
  it('answers 200 for an active seller, with a body that matches the contract', async () => {
    await start();
    const result = await get('/v1/sellers/good-shop');
    expect(result.status).toBe(200);
    expect(SellerProfileResponseSchema.safeParse(result.body).success).toBe(true);
    expect(SellerProfileResponseSchema.parse(result.body).availability).toBe('available');
  });

  it('answers 200 for a suspended seller, marked unavailable', async () => {
    await start({ ...ACTIVE, availability: 'unavailable' });
    const result = await get('/v1/sellers/gone-shop');
    expect(result.status).toBe(200);
    const parsed = SellerProfileResponseSchema.parse(result.body);
    expect(parsed.availability).toBe('unavailable');
    // The page still names the seller: it is a profile that says "unavailable", not a blank.
    expect(parsed.seller.displayName).toBe('Good Shop');
  });

  it('answers 200 for a seller with no bio, no language and no city', async () => {
    await start({ ...ACTIVE, bio: null, contentLanguage: null, city: null });
    const result = await get('/v1/sellers/bare-shop');
    expect(result.status).toBe(200);
    const parsed = SellerProfileResponseSchema.parse(result.body);
    expect(parsed.seller.bio).toBeNull();
    expect(parsed.seller.city).toBeNull();
  });

  it('answers 404 for a pending, closed or unknown seller — identically', async () => {
    const bodies: string[] = [];
    for (const slug of ['waiting-shop', 'left-shop', 'no-such-shop']) {
      await start({ outcome: 'not_found' });
      const result = await get(`/v1/sellers/${slug}`);
      expect(result.status, slug).toBe(404);
      // `instance` echoes the path the caller asked for, which they already know; everything else must
      // be identical, so the three states are one answer rather than three sharing a status code.
      const body = JSON.parse(result.raw) as Record<string, unknown>;
      delete body['instance'];
      bodies.push(JSON.stringify(body));
      await app?.close();
      app = undefined;
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('says nothing about why a seller was refused', async () => {
    await start({ outcome: 'not_found' });
    const raw = (await get('/v1/sellers/waiting-shop')).raw;
    // Not `status`: RFC 9457 carries the HTTP status as a field, which says nothing about the seller.
    for (const leak of ['pending', 'closed', 'suspended', 'verification', 'approved']) {
      expect(raw.toLowerCase(), leak).not.toContain(leak);
    }
  });

  it('answers 503 when the catalogue cannot be read', async () => {
    await start('throws');
    const result = await get('/v1/sellers/good-shop');
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(result.raw).not.toContain('unreachable');
  });

  it('passes the slug through unchanged', async () => {
    const recorded = await start();
    await get('/v1/sellers/good-shop');
    expect(recorded.slugs).toEqual(['good-shop']);
  });

  it('carries no field outside the approved projection', async () => {
    await start();
    const parsed = SellerProfileResponseSchema.parse((await get('/v1/sellers/good-shop')).body);
    expect(Object.keys(parsed).sort()).toEqual(['availability', 'seller']);
    expect(Object.keys(parsed.seller).sort()).toEqual([
      'bio',
      'city',
      'contentLanguage',
      'displayName',
      'slug',
    ]);
  });

  it('never carries a verification state, a contact detail or an internal status', async () => {
    await start();
    const raw = (await get('/v1/sellers/good-shop')).raw;
    for (const absent of [
      'verificationStatus',
      'verifiedAt',
      'legalName',
      'contactEmail',
      'contactPhoneE164',
      'userId',
      'suspensionReason',
      'countryCode',
      'governorate',
    ]) {
      expect(raw, absent).not.toContain(absent);
    }
  });

  it('does not answer 301: sellers keep no slug history', async () => {
    await start({ outcome: 'not_found' });
    expect((await get('/v1/sellers/old-name')).status).toBe(404);
  });
});
