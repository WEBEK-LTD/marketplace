import {
  SellerOnboardingRequestSchema,
  SellerOnboardingResponseSchema,
  type SellerOnboardingRequest,
} from '@repo/contracts';

/**
 * The onboarding form's logic, with no React in it (Phase 6-C).
 *
 * A plain module for the same reason the 5-F polling logic is one: everything interesting about a form is
 * decidable without a browser — what gets sent, what an empty optional field means, which sentence a refusal
 * becomes — and a pure function can be tested exactly, deterministically, with no DOM and no network. The
 * component around it holds state and renders; this decides.
 *
 * **The request is built by the shared contract, not by hand.** {@link SellerOnboardingRequestSchema} is the
 * same strict schema the BFF and the API apply, so the browser refuses what the server would refuse and for
 * the same reason, and there is no second set of limits here to drift out of step. Client-side validation is
 * a convenience; the server is authoritative, and a value that passes here can still be refused there.
 *
 * **An empty box is not a value.** A form submits `''` for every field the person left alone, and sending
 * that would make "no legal name" and "a legal name of nothing" two different things. Blank optional fields
 * are dropped from the body entirely rather than sent as empty strings or nulls.
 *
 * **A refusal is read from the problem code, never from a message.** The API's codes are the contract; its
 * sentences are for people, may be reworded, and are not something a browser should branch on.
 */

/** The ten fields the form collects, in the order it renders them. */
export const ONBOARDING_FIELDS = [
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
] as const;

export type OnboardingField = (typeof ONBOARDING_FIELDS)[number];

/** What the person has typed. Every field is a string, because that is what an input holds. */
export type OnboardingValues = Readonly<Record<OnboardingField, string>>;

/** The fields a storefront cannot be created without. Everything else is optional. */
const REQUIRED: readonly OnboardingField[] = ['slug', 'displayName', 'countryCode'];

/** The optional fields, dropped from the body when blank rather than sent empty. */
const OPTIONAL: readonly OnboardingField[] = [
  'legalName',
  'bio',
  'contentLanguage',
  'governorate',
  'city',
  'contactEmail',
  'contactPhone',
];

export const EMPTY_ONBOARDING_VALUES: OnboardingValues = Object.freeze({
  slug: '',
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

export type OnboardingBuild =
  | { readonly ok: true; readonly body: SellerOnboardingRequest }
  | { readonly ok: false; readonly incomplete: true }
  | { readonly ok: false; readonly incomplete: false };

/**
 * The body to send, or why it cannot be built.
 *
 * `incomplete` is separated from merely invalid so the form can say "fill these in" before it says "this is
 * not a valid seller address" — the two are different mistakes and deserve different sentences.
 */
export function buildOnboardingRequest(values: OnboardingValues): OnboardingBuild {
  for (const field of REQUIRED) {
    if (values[field].trim() === '') return { ok: false, incomplete: true };
  }

  const candidate: Record<string, string> = {};
  for (const field of REQUIRED) candidate[field] = values[field].trim();
  for (const field of OPTIONAL) {
    const value = values[field].trim();
    if (value !== '') candidate[field] = value;
  }

  const parsed = SellerOnboardingRequestSchema.safeParse(candidate);
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, incomplete: false };
}

/**
 * The storefront as the form renders it: a narrowed render type, built field by field.
 *
 * Not the contract object, even though the fields happen to match today. The projection is written out so
 * that a field added to the contract later cannot arrive in a rendered component by structural typing — the
 * same rule 5-F's `RenderableConversation` follows, and the reason it is a function rather than a cast.
 */
export interface RenderableCreatedSeller {
  readonly slug: string;
  readonly displayName: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly city: string | null;
  readonly countryCode: string;
}

export type OnboardingOutcome =
  | { readonly kind: 'created'; readonly seller: RenderableCreatedSeller }
  | { readonly kind: 'exists' }
  | { readonly kind: 'slug_taken' }
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
 * Sends one creation attempt to the BFF route on this origin and reports what came back.
 *
 * Same-origin, so the `__Host-mp_access` cookie travels and no token is ever handled here. The 201 body is
 * validated against the shared contract and projected: what the form then renders is what the server said
 * committed, not an echo of what was typed, and never an invented id or timestamp.
 */
export async function submitOnboarding(
  body: SellerOnboardingRequest,
  fetcher: typeof fetch = fetch,
  path = '/api/sellers/me',
): Promise<OnboardingOutcome> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'unavailable' };
  }

  const text = await response.text().catch(() => '');

  if (response.status === 201) {
    let parsed: ReturnType<typeof SellerOnboardingResponseSchema.safeParse>;
    try {
      parsed = SellerOnboardingResponseSchema.safeParse(JSON.parse(text));
    } catch {
      return { kind: 'unavailable' };
    }
    if (!parsed.success) return { kind: 'unavailable' };
    const seller = parsed.data.seller;
    return {
      kind: 'created',
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
  if (response.status === 409) {
    const code = problemCode(text);
    if (code === 'SELLER_PROFILE_EXISTS') return { kind: 'exists' };
    if (code === 'SELLER_SLUG_TAKEN') return { kind: 'slug_taken' };
    // A 409 this client does not recognise is not guessed at.
    return { kind: 'unavailable' };
  }
  if (response.status === 400) return { kind: 'invalid' };
  // A throttled attempt is not invalid information, so it does not get the "invalid" sentence. It reads as
  // temporarily unavailable with the retry the approved copy already offers, which is exactly what it is.
  return { kind: 'unavailable' };
}
