import { describe, expect, it } from 'vitest';
import {
  CreateSeoRedirectRequestSchema,
  REDIRECT_FROM_PATH_PATTERN,
  REDIRECT_NOTE_MAX,
  REDIRECT_PATH_MAX,
  REDIRECT_STATUS_CODES,
  REDIRECT_TO_PATH_PATTERN,
  RedirectResolutionResponseSchema,
  SeoRedirectDetailResponseSchema,
  SeoRedirectStateRequestSchema,
  SeoRedirectsResponseSchema,
  UpdateSeoRedirectRequestSchema,
} from '../src/seo-redirects.js';

/**
 * The redirect-map contract.
 *
 * Everything asserted here is a rule migration 0030 states as a constraint. These tests exist to prove the
 * restatement matches: a value the database would refuse must be refused here too, so an operator gets a 400
 * with a reason rather than a 500 from a constraint — and, just as importantly, a value the database would
 * **accept** must not be refused here, because a contract narrower than its table silently removes behaviour
 * nobody decided to remove.
 */

const VALID = { fromPath: '/old', toPath: '/new' } as const;

describe('the paths both sides of an entry must be', () => {
  it('accepts an ordinary relative path', () => {
    expect(REDIRECT_FROM_PATH_PATTERN.test('/old-offer')).toBe(true);
    expect(REDIRECT_FROM_PATH_PATTERN.test('/')).toBe(true);
    expect(REDIRECT_FROM_PATH_PATTERN.test('/a/b/c_d-e.f')).toBe(true);
    // Percent-encoding is ordinary in a path, and 0030's class allows it.
    expect(REDIRECT_FROM_PATH_PATTERN.test('/caf%C3%A9')).toBe(true);
  });

  it('refuses anything that is not relative', () => {
    expect(REDIRECT_FROM_PATH_PATTERN.test('old-offer')).toBe(false);
    expect(REDIRECT_FROM_PATH_PATTERN.test('https://evil.test/x')).toBe(false);
    expect(REDIRECT_FROM_PATH_PATTERN.test('')).toBe(false);
  });

  it('refuses a protocol-relative path, which is a URL to another host', () => {
    // The one way a relative-looking value could take a visitor off the site. 0030 forbids it with its own
    // `!~ '^//'` condition and the pattern here carries the same refusal.
    expect(REDIRECT_FROM_PATH_PATTERN.test('//evil.test')).toBe(false);
    expect(REDIRECT_TO_PATH_PATTERN.test('//evil.test/path')).toBe(false);
  });

  it('lets a destination carry a query string, as 0030 does, and a source not', () => {
    expect(REDIRECT_TO_PATH_PATTERN.test('/search?q=shoes&page=2')).toBe(true);
    expect(REDIRECT_FROM_PATH_PATTERN.test('/search?q=shoes')).toBe(false);
  });
});

describe('creating an entry', () => {
  it('accepts the smallest valid request', () => {
    const parsed = CreateSeoRedirectRequestSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
  });

  it('leaves the status code and the state absent so the column defaults decide them', () => {
    const parsed = CreateSeoRedirectRequestSchema.safeParse(VALID);
    expect(parsed.success && parsed.data.statusCode).toBeUndefined();
    expect(parsed.success && parsed.data.isActive).toBeUndefined();
  });

  it('accepts each of the four status codes 0030 permits and nothing else', () => {
    for (const code of REDIRECT_STATUS_CODES) {
      expect(CreateSeoRedirectRequestSchema.safeParse({ ...VALID, statusCode: code }).success).toBe(true);
    }
    for (const code of [200, 303, 304, 404, 410, 0, -301, 3.01]) {
      expect(CreateSeoRedirectRequestSchema.safeParse({ ...VALID, statusCode: code }).success).toBe(false);
    }
  });

  it('refuses an entry that points at itself, before the database has to', () => {
    expect(CreateSeoRedirectRequestSchema.safeParse({ fromPath: '/x', toPath: '/x' }).success).toBe(false);
  });

  it('refuses a destination that would leave the site', () => {
    for (const toPath of ['https://evil.test/x', '//evil.test', 'mailto:a@b.test', 'javascript:alert(1)']) {
      expect(CreateSeoRedirectRequestSchema.safeParse({ fromPath: '/x', toPath }).success).toBe(false);
    }
  });

  it('allows an entry to be staged switched off', () => {
    const parsed = CreateSeoRedirectRequestSchema.safeParse({ ...VALID, isActive: false });
    expect(parsed.success && parsed.data.isActive).toBe(false);
  });

  it('keeps a note, and allows no note', () => {
    expect(CreateSeoRedirectRequestSchema.safeParse({ ...VALID, note: 'campaign ended' }).success).toBe(true);
    expect(CreateSeoRedirectRequestSchema.safeParse({ ...VALID, note: null }).success).toBe(true);
  });

  it('refuses a path or a note long enough to be an attack rather than an address', () => {
    expect(
      CreateSeoRedirectRequestSchema.safeParse({ ...VALID, fromPath: `/${'a'.repeat(REDIRECT_PATH_MAX)}` }).success,
    ).toBe(false);
    expect(
      CreateSeoRedirectRequestSchema.safeParse({ ...VALID, note: 'n'.repeat(REDIRECT_NOTE_MAX + 1) }).success,
    ).toBe(false);
  });

  it('drops a field nobody declared rather than forwarding it', () => {
    const parsed = CreateSeoRedirectRequestSchema.safeParse({ ...VALID, priority: 10, pattern: '/old/*' });
    // Neither a priority nor a pattern exists on this map, and a request naming one must not carry it upstream.
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'priority' in parsed.data).toBe(false);
    expect(parsed.success && 'pattern' in parsed.data).toBe(false);
  });
});

describe('changing an entry', () => {
  it('accepts a change to one field', () => {
    expect(UpdateSeoRedirectRequestSchema.safeParse({ toPath: '/newer' }).success).toBe(true);
    expect(UpdateSeoRedirectRequestSchema.safeParse({ statusCode: 308 }).success).toBe(true);
  });

  it('refuses a request that changes nothing', () => {
    expect(UpdateSeoRedirectRequestSchema.safeParse({}).success).toBe(false);
  });

  it('takes an empty note as a request to clear it', () => {
    const parsed = UpdateSeoRedirectRequestSchema.safeParse({ note: '' });
    expect(parsed.success && parsed.data.note).toBe('');
  });

  it('cannot switch an entry on or off, because that is its own request', () => {
    const parsed = UpdateSeoRedirectRequestSchema.safeParse({ toPath: '/newer', isActive: true });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'isActive' in parsed.data).toBe(false);
  });

  it('refuses an edit that would make an entry point at itself', () => {
    expect(UpdateSeoRedirectRequestSchema.safeParse({ fromPath: '/x', toPath: '/x' }).success).toBe(false);
    // One side alone cannot be judged here — the other is whatever the stored row holds — so it is accepted and
    // 0030's constraint is what refuses it.
    expect(UpdateSeoRedirectRequestSchema.safeParse({ toPath: '/x' }).success).toBe(true);
  });
});

describe('switching an entry on or off', () => {
  it('carries exactly one boolean', () => {
    expect(SeoRedirectStateRequestSchema.safeParse({ isActive: true }).success).toBe(true);
    expect(SeoRedirectStateRequestSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(SeoRedirectStateRequestSchema.safeParse({}).success).toBe(false);
    expect(SeoRedirectStateRequestSchema.safeParse({ isActive: 'true' }).success).toBe(false);
  });
});

describe('the public resolution answer', () => {
  it('is a redirect or a clear nothing, and the two cannot be confused', () => {
    const redirect = RedirectResolutionResponseSchema.safeParse({
      outcome: 'redirect',
      toPath: '/new',
      statusCode: 301,
    });
    expect(redirect.success).toBe(true);

    const none = RedirectResolutionResponseSchema.safeParse({ outcome: 'none' });
    expect(none.success).toBe(true);
    // There is no `toPath` on the `none` member to be null, so a caller cannot redirect to nowhere by
    // forgetting to branch.
    expect(none.success && 'toPath' in none.data).toBe(false);
  });

  it('refuses a redirect answer with no destination, or with a status code the map cannot store', () => {
    expect(RedirectResolutionResponseSchema.safeParse({ outcome: 'redirect', statusCode: 301 }).success).toBe(false);
    expect(
      RedirectResolutionResponseSchema.safeParse({ outcome: 'redirect', toPath: '/new', statusCode: 303 }).success,
    ).toBe(false);
  });

  it('refuses a destination off the site even when the API claims one', () => {
    // The table cannot store one, so receiving one means something is wrong upstream and the caller must not
    // act on it.
    expect(
      RedirectResolutionResponseSchema.safeParse({
        outcome: 'redirect',
        toPath: 'https://evil.test/',
        statusCode: 301,
      }).success,
    ).toBe(false);
  });

  it('refuses an outcome it does not know', () => {
    expect(RedirectResolutionResponseSchema.safeParse({ outcome: 'maybe' }).success).toBe(false);
  });
});

describe('the admin responses', () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    fromPath: '/old',
    toPath: '/new',
    statusCode: 301,
    isActive: true,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  } as const;

  it('accepts a page of the map', () => {
    const parsed = SeoRedirectsResponseSchema.safeParse({ items: [row], nextCursor: null });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty map, which is what a fresh installation has', () => {
    expect(SeoRedirectsResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });

  it('carries the manage capability and where the chain ends on the detail', () => {
    const parsed = SeoRedirectDetailResponseSchema.safeParse({
      redirect: {
        ...row,
        createdBy: '22222222-2222-4222-8222-222222222222',
        canManage: true,
        resolvedToPath: '/newest',
        resolvedStatusCode: 302,
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.redirect.resolvedToPath).toBe('/newest');
  });

  it('allows the resolved destination to be absent, which is what a switched-off entry looks like', () => {
    const parsed = SeoRedirectDetailResponseSchema.safeParse({
      redirect: { ...row, isActive: false, createdBy: null, canManage: false, resolvedToPath: null, resolvedStatusCode: null },
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a detail with no manage capability on it', () => {
    const parsed = SeoRedirectDetailResponseSchema.safeParse({
      redirect: { ...row, createdBy: null, resolvedToPath: null, resolvedStatusCode: null },
    });
    // A console renders its controls from this field, so its absence must be a failure rather than a falsy
    // default that hides a control somebody is entitled to.
    expect(parsed.success).toBe(false);
  });
});
