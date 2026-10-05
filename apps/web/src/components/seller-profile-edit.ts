import {
  SellerProfileUpdateRequestSchema,
  SellerProfileUpdateResponseSchema,
  type SellerProfileUpdateRequest,
} from '@repo/contracts';

/**
 * The profile form's logic, with no React in it (Phase 6-D).
 *
 * A plain module for the same reason 6-C's is: what a form sends, what a blank box means and which sentence
 * a refusal becomes are all decidable without a browser, and a pure function can be tested exactly. The
 * component around it holds state and renders; this decides.
 *
 * **The blank-box rule, and why it is what it is.** The 6-A identity projection carries six fields —
 * `slug`, `displayName`, `status`, `verificationStatus`, `city`, `countryCode` — and 6-D was not permitted
 * to add a read operation or change that projection. So a seller's own `legalName`, `bio`,
 * `contentLanguage`, `governorate`, `contactEmail` and `contactPhone` are not readable by this page, and the
 * form cannot show them. The honest consequence, and the rule the whole module is built around:
 *
 *   * a field the page **knows** the current value of (display name, city, country) is pre-filled; clearing
 *     its box means clearing the column, so it is sent as `null` — for the two the schema forbids emptying,
 *     an empty box is a client-side validation failure instead;
 *   * a field the page **cannot** show starts blank, and a blank box is sent as nothing at all, so the
 *     stored value is preserved. It is changed by typing into it.
 *
 * That is why {@link buildProfileUpdate} takes the known values as well as the typed ones: "blank" means two
 * different things depending on whether the page could have shown a value, and only the caller knows which.
 * Clearing a field the page cannot display is therefore not offered here; it is available on the API, and a
 * later increment that adds a seller-profile read can offer it in the UI.
 *
 * **Only what changed is sent.** A field whose box still holds exactly what the server said is omitted, so
 * an edit to one field is a request about one field — which is also what makes the partial-update contract
 * meaningful rather than a formality.
 */

/** The nine editable fields, in the order the form renders them. */
export const PROFILE_FIELDS = [
  'displayName',
  'legalName',
  'bio',
  'contentLanguage',
  'countryCode',
  'governorate',
  'city',
  'contactEmail',
  'contactPhone',
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** What the person has typed. Every field is a string, because that is what an input holds. */
export type ProfileValues = Readonly<Record<ProfileField, string>>;

/**
 * The fields the seller identity lets this page display, and therefore the only ones whose empty box can
 * mean "clear this". Everything else is preserved when blank.
 */
export const KNOWN_FIELDS = ['displayName', 'city', 'countryCode'] as const;

/** The two the table declares `not null`: they can be changed, never emptied. */
const REQUIRED: readonly ProfileField[] = ['displayName', 'countryCode'];

export const EMPTY_PROFILE_VALUES: ProfileValues = Object.freeze({
  displayName: '',
  legalName: '',
  bio: '',
  contentLanguage: '',
  countryCode: '',
  governorate: '',
  city: '',
  contactEmail: '',
  contactPhone: '',
});

/** What the page could read: the three editable fields the 6-A projection carries. */
export interface KnownProfileValues {
  readonly displayName: string;
  readonly city: string | null;
  readonly countryCode: string;
}

/** The form's starting state: the known values filled in, the unreadable ones blank. */
export function initialProfileValues(known: KnownProfileValues): ProfileValues {
  return {
    ...EMPTY_PROFILE_VALUES,
    displayName: known.displayName,
    city: known.city ?? '',
    countryCode: known.countryCode,
  };
}

export type ProfileBuild =
  | { readonly ok: true; readonly body: SellerProfileUpdateRequest; readonly changed: boolean }
  | { readonly ok: false; readonly incomplete: true }
  | { readonly ok: false; readonly incomplete: false };

/**
 * The body to send, or why it cannot be built.
 *
 * `changed: false` means the person pressed save without altering anything: a valid request that would be a
 * round trip for nothing, which the form can decline to make.
 */
export function buildProfileUpdate(values: ProfileValues, known: KnownProfileValues): ProfileBuild {
  // The two that cannot be emptied are checked first, because "you left this blank" is a different message
  // from "this is not a valid value".
  for (const field of REQUIRED) {
    if (values[field].trim() === '') return { ok: false, incomplete: true };
  }

  const starting = initialProfileValues(known);
  const candidate: Record<string, string | null> = {};

  for (const field of PROFILE_FIELDS) {
    const typed = values[field].trim();
    const readable = (KNOWN_FIELDS as readonly string[]).includes(field);

    if (typed === '') {
      // A blank box on a field this page could display means "clear it"; on one it could not, it means
      // "leave it alone" — and only the second is omitted from the request.
      if (readable && starting[field].trim() !== '') candidate[field] = null;
      continue;
    }
    // Unchanged from what the server last said, so there is nothing to say about it.
    if (typed === starting[field].trim()) continue;
    candidate[field] = typed;
  }

  const changed = Object.keys(candidate).length > 0;
  const parsed = SellerProfileUpdateRequestSchema.safeParse(candidate);
  return parsed.success ? { ok: true, body: parsed.data, changed } : { ok: false, incomplete: false };
}

/**
 * The storefront as the form renders it: a narrowed render type, built field by field.
 *
 * Not the contract object, even though the fields match today. The projection is written out so that a field
 * added to the contract later cannot arrive in a rendered component by structural typing.
 */
export interface RenderableProfile {
  readonly slug: string;
  readonly displayName: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly city: string | null;
  readonly countryCode: string;
}

export type ProfileUpdateOutcome =
  | { readonly kind: 'saved'; readonly seller: RenderableProfile }
  | { readonly kind: 'not_editable' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

/** The problem code, if the body is a problem document. Anything else reads as no code at all. */
function problemCode(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const code = (parsed as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/**
 * Sends one edit to the BFF route on this origin and reports what came back.
 *
 * Same-origin, so the `__Host-mp_access` cookie travels and no token is ever handled here. The 200 body is
 * validated against the shared contract and projected: what the form then renders is what the server said is
 * stored, never an optimistic copy of what was typed, and never an invented id or timestamp.
 */
export async function submitProfileUpdate(
  body: SellerProfileUpdateRequest,
  fetcher: typeof fetch = fetch,
  path = '/api/sellers/me',
): Promise<ProfileUpdateOutcome> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'unavailable' };
  }

  const text = await response.text().catch(() => '');

  if (response.status === 200) {
    let parsed: ReturnType<typeof SellerProfileUpdateResponseSchema.safeParse>;
    try {
      parsed = SellerProfileUpdateResponseSchema.safeParse(JSON.parse(text));
    } catch {
      return { kind: 'unavailable' };
    }
    if (!parsed.success) return { kind: 'unavailable' };
    const seller = parsed.data.seller;
    return {
      kind: 'saved',
      seller: {
        slug: seller.slug,
        displayName: seller.displayName,
        status: seller.status,
        verificationStatus: seller.verificationStatus,
        city: seller.city,
        countryCode: seller.countryCode,
      },
    };
  }

  if (response.status === 401) return { kind: 'unauthenticated' };
  if (response.status === 404) return { kind: 'not_found' };
  if (response.status === 409) {
    return problemCode(text) === 'SELLER_PROFILE_NOT_EDITABLE'
      ? { kind: 'not_editable' }
      : { kind: 'unavailable' };
  }
  if (response.status === 400) return { kind: 'invalid' };
  // A throttled edit is not invalid information, so it does not get the "invalid" sentence.
  return { kind: 'unavailable' };
}
