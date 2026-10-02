import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_PROFILE_VALUES,
  KNOWN_FIELDS,
  PROFILE_FIELDS,
  buildProfileUpdate,
  initialProfileValues,
  submitProfileUpdate,
  type KnownProfileValues,
  type ProfileValues,
} from '../src/components/seller-profile-edit';
import { APP_DIR } from './support/next-server.js';

/**
 * The profile form's logic, without a browser (Phase 6-D).
 *
 * The rule this module exists to make testable, and the one most worth getting right:
 *
 *   * a field the page could display and the person emptied is **cleared** — sent as `null`;
 *   * a field the page could not display and left blank is **preserved** — not sent at all;
 *   * a field whose value is unchanged is not sent either, so an edit to one field is a request about one
 *     field.
 *
 * The middle case exists because the 6-A projection carries six fields and 6-D was not permitted to add a
 * read operation, so the form cannot show a seller their own legal name, bio, language, governorate or
 * contact details. Blank therefore cannot mean "clear" for those, and the tests below pin that distinction
 * from both sides rather than assuming it.
 *
 * Also asserted: a failure never clears the form, and the form never optimistically claims a save.
 */

const KNOWN: KnownProfileValues = { displayName: 'Good Shop', city: 'Cairo', countryCode: 'EG' };

const SELLER = {
  slug: 'good-shop',
  displayName: 'Renamed Shop',
  status: 'active',
  verificationStatus: 'verified',
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

/** The form's state after the person has typed nothing: the known values, and blanks elsewhere. */
function untouched(): ProfileValues {
  return initialProfileValues(KNOWN);
}

describe('the fields the form collects', () => {
  it('is the nine editable fields and nothing else', () => {
    expect([...PROFILE_FIELDS]).toEqual([
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

  it('has no field for the slug, a status, a verification state, a role or an owner', () => {
    for (const forbidden of [
      'slug',
      'userId',
      'status',
      'verificationStatus',
      'suspensionReason',
      'suspendedAt',
      'closedAt',
      'verifiedAt',
      'createdAt',
      'updatedAt',
      'role',
      'logoObjectPath',
      'bannerObjectPath',
    ]) {
      expect(PROFILE_FIELDS as readonly string[], forbidden).not.toContain(forbidden);
    }
  });

  it('names the three the seller identity actually carries', () => {
    expect([...KNOWN_FIELDS]).toEqual(['displayName', 'city', 'countryCode']);
  });

  it('starts empty, with a value for every field', () => {
    expect(Object.keys(EMPTY_PROFILE_VALUES).sort()).toEqual([...PROFILE_FIELDS].sort());
    expect(Object.values(EMPTY_PROFILE_VALUES).every((value) => value === '')).toBe(true);
  });

  it('pre-fills exactly what the page could read, and nothing else', () => {
    const initial = initialProfileValues(KNOWN);

    expect(initial.displayName).toBe('Good Shop');
    expect(initial.city).toBe('Cairo');
    expect(initial.countryCode).toBe('EG');
    for (const blank of ['legalName', 'bio', 'contentLanguage', 'governorate', 'contactEmail', 'contactPhone'] as const) {
      expect(initial[blank], blank).toBe('');
    }
  });

  it('pre-fills an absent city as blank rather than as the word null', () => {
    expect(initialProfileValues({ ...KNOWN, city: null }).city).toBe('');
  });
});

describe('building the update', () => {
  it('sends nothing when nothing was touched', () => {
    const built = buildProfileUpdate(untouched(), KNOWN);

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual({});
    expect(built.changed).toBe(false);
  });

  it('sends only the field that changed', () => {
    const built = buildProfileUpdate({ ...untouched(), displayName: 'Renamed Shop' }, KNOWN);

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual({ displayName: 'Renamed Shop' });
    expect(built.changed).toBe(true);
  });

  it('treats a re-typed identical value as no change', () => {
    const built = buildProfileUpdate({ ...untouched(), displayName: '  Good Shop  ' }, KNOWN);

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual({});
    expect(built.changed).toBe(false);
  });

  it('sends a field the page could not display as a value when it is typed into', () => {
    const built = buildProfileUpdate(
      { ...untouched(), legalName: 'Good Shop Trading LLC', bio: 'We restore furniture.' },
      KNOWN,
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual({ legalName: 'Good Shop Trading LLC', bio: 'We restore furniture.' });
  });

  it('omits a field the page could not display when it is left blank, so the stored value survives', () => {
    const built = buildProfileUpdate(untouched(), KNOWN);

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    for (const field of ['legalName', 'bio', 'contentLanguage', 'governorate', 'contactEmail', 'contactPhone']) {
      expect(Object.hasOwn(built.body, field), field).toBe(false);
    }
  });

  it('clears a field the page could display when its box is emptied', () => {
    const built = buildProfileUpdate({ ...untouched(), city: '' }, KNOWN);

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.hasOwn(built.body, 'city')).toBe(true);
    expect(built.body.city).toBeNull();
    expect(built.changed).toBe(true);
  });

  it('does not try to clear a city that was already absent', () => {
    const known: KnownProfileValues = { ...KNOWN, city: null };
    const built = buildProfileUpdate(initialProfileValues(known), known);

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.hasOwn(built.body, 'city')).toBe(false);
  });

  it.each(['displayName', 'countryCode'] as const)('reports an emptied %s as incomplete', (field) => {
    const built = buildProfileUpdate({ ...untouched(), [field]: '' }, KNOWN);

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.incomplete).toBe(true);
  });

  it.each([
    ['a one-character display name', { displayName: 'A' }],
    ['an eighty-one-character display name', { displayName: 'n'.repeat(81) }],
    ['a 2001-character bio', { bio: 'b'.repeat(2001) }],
    ['a three-character country code', { countryCode: 'EGY' }],
    ['an address with no domain', { contactEmail: 'not-an-email' }],
    ['a phone without the plus', { contactPhone: '0201555000001' }],
  ])('refuses %s as invalid rather than incomplete', (_name, override) => {
    const built = buildProfileUpdate({ ...untouched(), ...override }, KNOWN);

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.incomplete).toBe(false);
  });

  it('accepts the far side of every boundary', () => {
    for (const override of [
      { displayName: 'Ab' },
      { displayName: 'n'.repeat(80) },
      { bio: 'b'.repeat(2000) },
      { contactPhone: '+201555000001' },
      { contactEmail: 'a@b.co' },
    ]) {
      expect(buildProfileUpdate({ ...untouched(), ...override }, KNOWN).ok, JSON.stringify(override)).toBe(true);
    }
  });

  it('never builds a body containing the slug or a state, whatever was typed', () => {
    const built = buildProfileUpdate(
      { ...untouched(), displayName: 'Renamed Shop', bio: 'x', legalName: 'y' },
      KNOWN,
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const keys = Object.keys(built.body);
    for (const forbidden of ['slug', 'status', 'verificationStatus', 'userId', 'updatedAt']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

describe('submitting', () => {
  const body = { displayName: 'Renamed Shop' };

  it('patches this origin with the session cookie and nothing else', async () => {
    const calls: Call[] = [];
    await submitProfileUpdate(body, responder(200, { seller: SELLER }, calls));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/sellers/me');
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.credentials).toBe('same-origin');
  });

  it('reports the saved storefront from the server response, not from what was typed', async () => {
    const calls: Call[] = [];
    const outcome = await submitProfileUpdate(
      { displayName: 'What The Person Typed' },
      responder(200, { seller: SELLER }, calls),
    );

    expect(outcome.kind).toBe('saved');
    if (outcome.kind !== 'saved') return;
    // The server said 'Renamed Shop'; the request said something else. The server wins.
    expect(outcome.seller.displayName).toBe('Renamed Shop');
    expect(outcome.seller).toEqual(SELLER);
  });

  it('projects the response field by field, so an extra field cannot arrive with it', async () => {
    const calls: Call[] = [];
    const outcome = await submitProfileUpdate(
      body,
      responder(200, { seller: { ...SELLER, userId: '11111111-1111-4111-8111-111111111111' } }, calls),
    );

    expect(outcome.kind).toBe('unavailable');
  });

  it('reads a 409 not-editable as its own outcome', async () => {
    const calls: Call[] = [];
    const outcome = await submitProfileUpdate(
      body,
      responder(409, problem('SELLER_PROFILE_NOT_EDITABLE'), calls),
    );

    expect(outcome.kind).toBe('not_editable');
  });

  it('does not guess at a 409 code it does not know', async () => {
    const calls: Call[] = [];
    const outcome = await submitProfileUpdate(body, responder(409, problem('SOMETHING_NEW'), calls));

    expect(outcome.kind).toBe('unavailable');
  });

  it.each([
    [400, 'invalid'],
    [401, 'unauthenticated'],
    [403, 'unavailable'],
    [404, 'not_found'],
    [429, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('reads a %i as %s', async (status, kind) => {
    const calls: Call[] = [];
    const outcome = await submitProfileUpdate(body, responder(status, problem('ANY'), calls));

    expect(outcome.kind).toBe(kind);
  });

  it('reports a network failure as unavailable rather than throwing at the form', async () => {
    const outcome = await submitProfileUpdate(body, async () => {
      throw new Error('connection refused');
    });

    expect(outcome.kind).toBe('unavailable');
  });

  it('reports an unparsable success body as unavailable', async () => {
    const calls: Call[] = [];
    expect((await submitProfileUpdate(body, responder(200, 'not json', calls))).kind).toBe('unavailable');
    expect((await submitProfileUpdate(body, responder(200, { seller: {} }, calls))).kind).toBe('unavailable');
  });

  it('never invents an id or a timestamp, because the contract carries neither', async () => {
    const calls: Call[] = [];
    const outcome = await submitProfileUpdate(body, responder(200, { seller: SELLER }, calls));
    if (outcome.kind !== 'saved') throw new Error('expected a save');

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
  const source = readFileSync(join(APP_DIR, 'src/components/seller-profile-form.tsx'), 'utf8');

  it('keeps the entered values in one state object, so a failure cannot clear the form', () => {
    expect(source).toContain('useState<ProfileValues>');
    // Two writers only: the per-field `set` helper, and nothing else. No failure path resets the object.
    expect(source.match(/setValues\(/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/setValues\(\s*\{?\s*\.{0,3}\s*EMPTY_PROFILE_VALUES/);
    expect(source).not.toMatch(/setValues\(\s*initialProfileValues/);
  });

  it('renders controlled inputs for every editable field', () => {
    for (const field of PROFILE_FIELDS) {
      expect(source, field).toContain(`values.${field}`);
      expect(source, field).toContain(`set('${field}'`);
    }
  });

  it('disables submit while a save is in flight', () => {
    expect(source).toContain('disabled={pending}');
    expect(source).toContain('{pending ? labels.saving : labels.save}');
  });

  it('claims a save only after the server said so', () => {
    // `setSaved(true)` appears exactly twice: once for the no-change case, once inside the 'saved' branch.
    expect(source.match(/setSaved\(true\)/g) ?? []).toHaveLength(2);
    expect(source).toMatch(/outcome\.kind === 'saved'[\s\S]{0,120}setSaved\(true\)/);
  });

  it('takes copy and the three readable values, and nothing else', () => {
    const labels = /export interface SellerProfileFormLabels \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(labels).not.toBe('');
    const members = labels.match(/readonly \w+: [^;]+;/g) ?? [];
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((member) => member.endsWith(': string;'))).toBe(true);
    // The only other prop is the narrowed KnownProfileValues.
    expect(source).toContain('readonly known: KnownProfileValues');
  });

  it('never receives or names the slug, a status or a verification state', () => {
    for (const absent of ['labels.slug', 'known.slug', 'known.status', 'known.verificationStatus']) {
      expect(source, absent).not.toContain(absent);
    }
  });

  it('never names a token, an identifier or a provider', () => {
    for (const absent of ['userId', 'accessToken', 'supabase', 'createClient', 'x-session-token']) {
      expect(source.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
  });

  it('offers no status, verification, role, moderation, payout or media control', () => {
    for (const absent of [
      'name="slug"',
      'name="status"',
      'name="verificationStatus"',
      'name="role"',
      'name="suspensionReason"',
      'type="file"',
      'payout',
      'iban',
      'moderation',
      'document',
    ]) {
      expect(source.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
  });

  it('lays out with logical properties, so /ar mirrors without a second stylesheet', () => {
    expect(source).not.toMatch(/\b(ml|mr|pl|pr)-\d|\btext-(left|right)\b|\b(left|right)-\d/);
  });
});
