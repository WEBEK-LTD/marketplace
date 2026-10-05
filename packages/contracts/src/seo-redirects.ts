import { z } from './zod.js';

/**
 * The SEO redirect map — the admin surface that maintains it, and the one public question it answers.
 *
 * **Every value here is one migration 0030 already constrains.** The two path shapes, the prohibition on
 * leaving the site, the four status codes and the refusal of an entry that points at itself are all
 * constraints on `public.redirects`; they are restated here so that a malformed request is a 400 at the edge
 * instead of a 500 from a constraint, never so that this file decides them. Where the two could disagree the
 * database wins, and the contract is the thing that gets corrected.
 *
 * **LIVE PAGE WINS is not expressed in this contract, because it is not a property of the map.** The public
 * site resolves an incoming path against its own authoritative route behaviour first and consults the map
 * only for a path that would otherwise answer 404. {@link RedirectResolutionResponseSchema} therefore answers
 * one narrow question — does the map name this path — and says nothing about live pages.
 *
 * **The resolution answer is a union rather than a 404.** "The map names no redirect for this path" is a
 * perfectly good answer and is the common one; a 404 would be indistinguishable from the API being unreachable,
 * and a caller that cannot tell those apart would have to choose between swallowing an outage and refusing to
 * render a page that was fine.
 *
 * **There is no priority, no group, no wildcard and no pattern.** One entry names one exact `from_path`, which
 * is what 0030's unique index means, and the chain, the hop limit and the cycle stop belong to its resolver.
 */

// ---------------------------------------------------------------------------------------------------
// Shared vocabulary — every value below is one the database already constrains
// ---------------------------------------------------------------------------------------------------

/** The four codes `redirects_status_code_allowed` permits, and exactly those. */
export const REDIRECT_STATUS_CODES = [301, 302, 307, 308] as const;
export type RedirectStatusCode = (typeof REDIRECT_STATUS_CODES)[number];
export const RedirectStatusCodeSchema = z
  .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
  .openapi('RedirectStatusCode');

/**
 * The shape `redirects_from_path_is_relative` enforces: a relative path, and never a protocol-relative one.
 *
 * 0030 expresses it as two conditions — `~ '^/[A-Za-z0-9/_\-.%]*$'` and `!~ '^//'` — and the lookahead below is
 * the second of them. A path that begins `//` is a URL to another host for a browser, which is the one way a
 * relative-looking value could send somebody off the site.
 */
export const REDIRECT_FROM_PATH_PATTERN = /^\/(?!\/)[A-Za-z0-9/_\-.%]*$/;

/** The same rule for the destination, which 0030 additionally lets carry a query string. */
export const REDIRECT_TO_PATH_PATTERN = /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/;

/**
 * Request-size guards, **not** stored rules.
 *
 * 0030 puts no length constraint on either path or on the note, and nothing here narrows what the table will
 * store. These bounds exist so that an unbounded string never reaches a parameter binding, and they are set
 * where no address or note anybody would type can reach them: 2048 is the practical limit of a URL, and a note
 * is a line of explanation rather than a document.
 */
export const REDIRECT_PATH_MAX = 2048;
export const REDIRECT_NOTE_MAX = 1000;

const fromPath = z.string().min(1).max(REDIRECT_PATH_MAX).regex(REDIRECT_FROM_PATH_PATTERN);
const toPath = z.string().min(1).max(REDIRECT_PATH_MAX).regex(REDIRECT_TO_PATH_PATTERN);

export const RedirectFromPathSchema = fromPath;
export const RedirectToPathSchema = toPath;

// ---------------------------------------------------------------------------------------------------
// The public question
// ---------------------------------------------------------------------------------------------------

/**
 * Where the map sends one path, or nothing.
 *
 * `toPath` is the **end of the chain**, not the next step, and `statusCode` is the code stored on the last entry
 * that was followed — both of them 0030's resolver's answers rather than this contract's.
 */
export const RedirectResolutionResponseSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({
        outcome: z.literal('redirect'),
        toPath,
        statusCode: RedirectStatusCodeSchema,
      })
      // Strict, like every other response shape here: a field nobody declared on an answer this caller is about to
      // act on means something upstream is not what this app thinks, and the safe reading of that is no redirect.
      .strict(),
    z.object({ outcome: z.literal('none') }).strict(),
  ])
  .openapi('RedirectResolutionResponse');
export type RedirectResolutionResponse = z.infer<typeof RedirectResolutionResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// The admin surface
// ---------------------------------------------------------------------------------------------------

export const SEO_REDIRECTS_DEFAULT_LIMIT = 25;
export const SEO_REDIRECTS_MAX_LIMIT = 100;

/** One row of the map, as the list shows it. */
export const SeoRedirectSchema = z
  .object({
    id: z.string().uuid(),
    fromPath: fromPath,
    toPath: toPath,
    statusCode: RedirectStatusCodeSchema,
    /** An inactive entry is stored and audited and redirects nobody. */
    isActive: z.boolean(),
    note: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  // Strict, like the facets of 8-D and for the same reason: a response field nobody declared must be a clean
  // failure at the BFF rather than something stripped on its way to a browser. A map entry is an instruction about
  // an address, and an undeclared field on one is a sign that something upstream is not what this console thinks.
  .strict()
  .openapi('SeoRedirect');
export type SeoRedirect = z.infer<typeof SeoRedirectSchema>;

export const SeoRedirectsResponseSchema = z
  .object({
    items: z.array(SeoRedirectSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SeoRedirectsResponse');
export type SeoRedirectsResponse = z.infer<typeof SeoRedirectsResponseSchema>;

/**
 * One entry, with the two things the list does not carry.
 *
 * `canManage` is the second seeded key, reported so a console renders its controls from the server's answer
 * rather than from a role name. `resolvedToPath` and `resolvedStatusCode` are where this entry's chain actually
 * **ends**, so an operator who has just pointed one path at another can see whether the destination is itself
 * redirected onwards — and they are null when the map would not redirect this path at all, which is what an
 * entry that is switched off, or one sitting in a cycle, looks like from the outside.
 */
export const SeoRedirectDetailSchema = SeoRedirectSchema.extend({
  createdBy: z.string().uuid().nullable(),
  canManage: z.boolean(),
  resolvedToPath: z.string().nullable(),
  resolvedStatusCode: RedirectStatusCodeSchema.nullable(),
})
  .strict()
  .openapi('SeoRedirectDetail');
export type SeoRedirectDetail = z.infer<typeof SeoRedirectDetailSchema>;

export const SeoRedirectDetailResponseSchema = z
  .object({ redirect: SeoRedirectDetailSchema })
  .strict()
  .openapi('SeoRedirectDetailResponse');
export type SeoRedirectDetailResponse = z.infer<typeof SeoRedirectDetailResponseSchema>;

/**
 * Creating an entry.
 *
 * `statusCode` and `isActive` are optional because 0030's columns have defaults — 301 and active. `isActive:
 * false` is how an operator stages an entry and switches it on separately.
 */
export const CreateSeoRedirectRequestSchema = z
  .object({
    fromPath: fromPath,
    toPath: toPath,
    statusCode: RedirectStatusCodeSchema.optional(),
    note: z.string().max(REDIRECT_NOTE_MAX).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.fromPath !== value.toPath, {
    message: 'a redirect may not point at itself',
  })
  .openapi('CreateSeoRedirectRequest');
export type CreateSeoRedirectRequest = z.infer<typeof CreateSeoRedirectRequestSchema>;

export const CreateSeoRedirectResponseSchema = z
  .object({ id: z.string().uuid() })
  .strict()
  .openapi('CreateSeoRedirectResponse');
export type CreateSeoRedirectResponse = z.infer<typeof CreateSeoRedirectResponseSchema>;

/**
 * Changing an entry.
 *
 * Every field is optional and an absent field changes nothing. **`isActive` is deliberately not here**: the
 * state has its own request below, so correcting a destination can never switch a redirect on, and turning one
 * off is one unambiguous action in the audit trail rather than a field inside an edit.
 *
 * `note: ""` clears the note, which is why it is a plain string rather than only a nullable one.
 */
export const UpdateSeoRedirectRequestSchema = z
  .object({
    fromPath: fromPath.optional(),
    toPath: toPath.optional(),
    statusCode: RedirectStatusCodeSchema.optional(),
    note: z.string().max(REDIRECT_NOTE_MAX).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field must be present' })
  .refine(
    (value) =>
      value.fromPath === undefined || value.toPath === undefined || value.fromPath !== value.toPath,
    { message: 'a redirect may not point at itself' },
  )
  .openapi('UpdateSeoRedirectRequest');
export type UpdateSeoRedirectRequest = z.infer<typeof UpdateSeoRedirectRequestSchema>;

/** Switching one entry on or off. The only request that can change that field. */
export const SeoRedirectStateRequestSchema = z
  .object({ isActive: z.boolean() })
  .openapi('SeoRedirectStateRequest');
export type SeoRedirectStateRequest = z.infer<typeof SeoRedirectStateRequestSchema>;

export const SeoRedirectWriteResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict()
  .openapi('SeoRedirectWriteResponse');
export type SeoRedirectWriteResponse = z.infer<typeof SeoRedirectWriteResponseSchema>;
