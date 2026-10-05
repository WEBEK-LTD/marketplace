import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ONBOARDING_VALUES,
  ONBOARDING_FIELDS,
  buildOnboardingRequest,
  submitOnboarding,
  type OnboardingValues,
} from '../src/components/seller-onboarding';
import { APP_DIR } from './support/next-server.js';

/**
 * The onboarding form's logic, without a browser (Phase 6-C).
 *
 * Everything decidable about a form is decided here: what gets sent, what a blank optional field means, which
 * outcome each response becomes, and what happens to the values when an attempt fails. No DOM, no network, no
 * Playwright — a pure function, exact inputs, exact outputs, the same approach 5-F took to polling.
 *
 * The three properties that matter most:
 *
 *   * **an empty box is not a value** — a blank optional field is dropped from the body, never sent as `''`
 *     or `null`, so "no legal name" and "a legal name of nothing" cannot become two different states;
 *   * **a refusal is read from the problem code**, not from a sentence, so reworded copy cannot change what
 *     the form does;
 *   * **a failure never clears the form** — asserted against the component's source, because the values live
 *     in one state object that no failure path touches.
 */

const VALUES: OnboardingValues = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  legalName: 'Good Shop Trading LLC',
  bio: 'We restore mid-century furniture.',
  contentLanguage: 'en',
  countryCode: 'EG',
  governorate: 'Cairo Governorate',
  city: 'Cairo',
  contactEmail: 'owner@example.invalid',
  contactPhone: '+201555000001',
};

const SELLER = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  status: 'pending',
  verificationStatus: 'unverified',
  city: 'Cairo',
  countryCode: 'EG',
};

interface Call {
  readonly path: string;
  readonly method: string | undefined;
  readonly credentials: RequestCredentials | undefined;
  readonly body: string | undefined;
}

function responder(
  status: number,
  payload: unknown,
  calls: Call[],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    calls.push({
      path: String(input),
      method: init?.method,
      credentials: init?.credentials,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  };
}

const problem = (code: string) => ({
  type: 'about:blank',
  title: 'Conflict',
  status: 409,
  detail: 'A sentence the API owns.',
  instance: '/v1/sellers/me',
  code,
});

describe('the fields the form collects', () => {
  it('is the ten approved onboarding fields and nothing else', () => {
    expect([...ONBOARDING_FIELDS]).toEqual([
      'slug',
      'displayName',
      'legalName',
      'bio',
      'contentLanguage',
      'countryCode',
      'governorate',
      'city',
      'contactEmail',
      'contactPhone',
    ]);
  });

  it('has no field for a status, a verification state, a role or an owner', () => {
    for (const forbidden of [
      'userId',
      'status',
      'verificationStatus',
      'suspensionReason',
      'suspendedAt',
      'closedAt',
      'verifiedAt',
      'role',
      'logoObjectPath',
      'bannerObjectPath',
    ]) {
      expect(ONBOARDING_FIELDS as readonly string[], forbidden).not.toContain(forbidden);
    }
  });

  it('starts empty, with a value for every field', () => {
    expect(Object.keys(EMPTY_ONBOARDING_VALUES).sort()).toEqual([...ONBOARDING_FIELDS].sort());
    expect(Object.values(EMPTY_ONBOARDING_VALUES).every((value) => value === '')).toBe(true);
  });
});

describe('building the request', () => {
  it('sends every field the person filled in', () => {
    const built = buildOnboardingRequest(VALUES);

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual(VALUES);
  });

  it('drops a blank optional field rather than sending an empty string', () => {
    const built = buildOnboardingRequest({
      ...VALUES,
      legalName: '',
      bio: '   ',
      contentLanguage: '',
      governorate: '',
      city: '',
      contactEmail: '',
      contactPhone: '',
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.keys(built.body).sort()).toEqual(['countryCode', 'displayName', 'slug']);
  });

  it('trims what it does send', () => {
    const built = buildOnboardingRequest({ ...VALUES, displayName: '  Good Shop  ', city: '  Cairo  ' });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.displayName).toBe('Good Shop');
    expect(built.body.city).toBe('Cairo');
  });

  it.each(['slug', 'displayName', 'countryCode'] as const)('reports a missing %s as incomplete', (field) => {
    const built = buildOnboardingRequest({ ...VALUES, [field]: '' });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.incomplete).toBe(true);
  });

  it.each([
    ['an uppercase slug', { slug: 'Good-Shop' }],
    ['an underscore in the slug', { slug: 'good_shop' }],
    ['a two-character slug', { slug: 'ab' }],
    ['a fifty-one-character slug', { slug: 'a'.repeat(51) }],
    ['a hyphen at the start', { slug: '-good-shop' }],
    ['a hyphen at the end', { slug: 'good-shop-' }],
    ['a one-character display name', { displayName: 'A' }],
    ['an eighty-one-character display name', { displayName: 'n'.repeat(81) }],
    ['a 2001-character bio', { bio: 'b'.repeat(2001) }],
    ['a three-character country code', { countryCode: 'EGY' }],
    ['an address with no domain', { contactEmail: 'not-an-email' }],
    ['a phone without the plus', { contactPhone: '0201555000001' }],
  ])('refuses %s as invalid rather than incomplete', (_name, override) => {
    const built = buildOnboardingRequest({ ...VALUES, ...override });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.incomplete).toBe(false);
  });

  it('accepts the far side of every boundary', () => {
    for (const override of [
      { slug: 'abc' },
      { slug: `${'a'.repeat(49)}b` },
      { displayName: 'Ab' },
      { displayName: 'n'.repeat(80) },
      { bio: 'b'.repeat(2000) },
    ]) {
      expect(buildOnboardingRequest({ ...VALUES, ...override }).ok, JSON.stringify(override)).toBe(true);
    }
  });
});

describe('submitting', () => {
  it('posts the body to this origin with the session cookie and nothing else', async () => {
    const calls: Call[] = [];
    const built = buildOnboardingRequest(VALUES);
    if (!built.ok) throw new Error('the fixture must build');

    await submitOnboarding(built.body, responder(201, { seller: SELLER }, calls));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/sellers/me');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.credentials).toBe('same-origin');
    // Same-origin: the BFF route on this origin, never the API and never a provider.
    expect(calls[0]?.path.startsWith('/')).toBe(true);
  });

  it('reports the created storefront from the server response', async () => {
    const calls: Call[] = [];
    const built = buildOnboardingRequest(VALUES);
    if (!built.ok) throw new Error('the fixture must build');

    const outcome = await submitOnboarding(built.body, responder(201, { seller: SELLER }, calls));

    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.seller).toEqual(SELLER);
  });

  it('projects the response field by field, so an extra field cannot arrive with it', async () => {
    const calls: Call[] = [];
    const built = buildOnboardingRequest(VALUES);
    if (!built.ok) throw new Error('the fixture must build');

    // A body with a seventh field fails the strict contract, so it is a clean failure rather than a
    // storefront carrying somebody's identifier.
    const outcome = await submitOnboarding(
      built.body,
      responder(201, { seller: { ...SELLER, userId: '11111111-1111-4111-8111-111111111111' } }, calls),
    );

    expect(outcome.kind).toBe('unavailable');
  });

  it.each([
    ['SELLER_PROFILE_EXISTS', 'exists'],
    ['SELLER_SLUG_TAKEN', 'slug_taken'],
  ])('reads a 409 %s as %s', async (code, kind) => {
    const calls: Call[] = [];
    const built = buildOnboardingRequest(VALUES);
    if (!built.ok) throw new Error('the fixture must build');

    const outcome = await submitOnboarding(built.body, responder(409, problem(code), calls));

    expect(outcome.kind).toBe(kind);
  });

  it('does not guess at a 409 code it does not know', async () => {
    const calls: Call[] = [];
    const built = buildOnboardingRequest(VALUES);
    if (!built.ok) throw new Error('the fixture must build');

    const outcome = await submitOnboarding(built.body, responder(409, problem('SOMETHING_NEW'), calls));

    expect(outcome.kind).toBe('unavailable');
  });

  it.each([
    [400, 'invalid'],
    [401, 'unauthenticated'],
    [403, 'unavailable'],
    [429, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('reads a %i as %s', async (status, kind) => {
    const calls: Call[] = [];
    const built = buildOnboardingRequest(VALUES);
    if (!built.ok) throw new Error('the fixture must build');

    const outcome = await submitOnboarding(built.body, responder(status, problem('ANY'), calls));

    expect(outcome.kind).toBe(kind);
  });

  it('reports a network failure as unavailable rather than throwing at the form', async () => {
    const built = buildOnboardingRequest(VALUES);
    if (!built.ok) throw new Error('the fixture must build');

    const outcome = await submitOnboarding(built.body, async () => {
      throw new Error('connection refused');
    });

    expect(outcome.kind).toBe('unavailable');
  });

  it('reports an unparsable success body as unavailable', async () => {
    const calls: Call[] = [];
    const built = buildOnboardingRequest(VALUES);
    if (!built.ok) throw new Error('the fixture must build');

    expect((await submitOnboarding(built.body, responder(201, 'not json', calls))).kind).toBe('unavailable');
    expect((await submitOnboarding(built.body, responder(201, { seller: {} }, calls))).kind).toBe(
      'unavailable',
    );
  });

  it('never invents an id or a timestamp, because the contract carries neither', async () => {
    const calls: Call[] = [];
    const built = buildOnboardingRequest(VALUES);
    if (!built.ok) throw new Error('the fixture must build');

    const outcome = await submitOnboarding(built.body, responder(201, { seller: SELLER }, calls));
    if (outcome.kind !== 'created') throw new Error('expected a creation');

    expect(Object.keys(outcome.seller).sort()).toEqual([
      'city',
      'countryCode',
      'displayName',
      'slug',
      'status',
      'verificationStatus',
    ]);
    expect(JSON.stringify(outcome.seller)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });
});

describe('the form component itself', () => {
  const source = readFileSync(join(APP_DIR, 'src/components/seller-onboarding-form.tsx'), 'utf8');

  it('keeps the entered values in one state object, so a failure cannot clear the form', () => {
    expect(source).toContain('useState<OnboardingValues>');
    // One writer: the per-field `set` helper. No failure path — and nothing else at all — reassigns the
    // whole object after the initial state, so a refusal cannot empty the form.
    expect(source.match(/setValues\(/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/setValues\(\s*\{?\s*\.{0,3}\s*EMPTY_ONBOARDING_VALUES/);
  });

  it('renders controlled inputs, which is what makes preservation possible', () => {
    for (const field of ONBOARDING_FIELDS) {
      expect(source, field).toContain(`values.${field}`);
      expect(source, field).toContain(`set('${field}'`);
    }
  });

  it('warns that the slug is permanent, beside the slug field', () => {
    expect(source).toContain('seller-slug-permanent');
    expect(source).toContain('labels.slugPermanent');
  });

  it('takes nothing but strings as props', () => {
    // The labels interface is the whole of the client boundary on this page: every member is a string.
    const labels = /export interface SellerOnboardingLabels \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(labels).not.toBe('');
    const members = labels.match(/readonly \w+: [^;]+;/g) ?? [];
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((member) => member.endsWith(': string;'))).toBe(true);
  });

  it('never names a token, an identifier or a provider', () => {
    for (const absent of ['userId', 'accessToken', 'supabase', 'createClient', 'x-session-token']) {
      expect(source.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
  });

  it('offers no status, verification, role, moderation, payout or media control', () => {
    for (const absent of [
      'name="status"',
      'name="verificationStatus"',
      'name="role"',
      'name="suspensionReason"',
      'type="file"',
      'payout',
      'iban',
      'moderation',
    ]) {
      expect(source.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
  });
});
