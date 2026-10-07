import { z } from './zod.js';

/**
 * Blocking somebody (Phase 8, migration 0103).
 *
 * `public.user_blocks` and `public.is_blocked_between` have existed since 0005, and six closed increments
 * refuse an action when the predicate is true. Nothing could create the row. These are the shapes that
 * finally let somebody create it.
 *
 * Four decisions are load-bearing, and each of them is about an identifier.
 *
 *   * **No request names an account, and no response returns one.** There is no `userId`, `blockedUserId`
 *     or `accountId` field anywhere below. A person is named by one of two handles the caller already
 *     holds — a conversation they are in, or a seller slug they were shown — and that is the whole of the
 *     input. 4-E decided that a public seller profile exposes five fields and that the account identifier
 *     is not one of them; a request shape carrying one would hand it back.
 *   * **Exactly one handle per request.** `BlockRequestSchema` is a union of two single-key objects, so a
 *     body with both is refused by the schema rather than resolved by a precedence rule nobody decided.
 *     The same union is what makes "neither" impossible to express.
 *   * **The unblock reference is opaque and is not an identifier.** `reference` is a versioned token the
 *     API mints over a row it just returned to this caller. It is not a credential: the remover re-applies
 *     its own ownership test inside the statement, so a reference lifted from somebody else's list removes
 *     nothing and answers exactly as a reference for a block that was never there. It exists so the list
 *     can be acted on without the account identifier ever crossing the boundary.
 *   * **A blocked person is described, not identified.** A display name when they have one and a storefront
 *     slug when they have one, both nullable because an account may have neither. Nothing else: no contact
 *     detail, no status, no account state, and nothing about what they did.
 *
 * Not here, deliberately: no reverse lookup and no "who blocked me" — the shape for that answer does not
 * exist in this file, which is the only kind of guarantee a contract can make. No staff or moderation
 * view. No report, suspension or ban. No notification to the blocked person. No count, cap or quota. No
 * catalogue filter: a blocked seller's listings stay exactly as visible as before, and no field below
 * could carry a request to change that.
 */

/* ------------------------------------------------------------------------------------------------ */
/* Limits                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The same page size the rest of the 7-E account surfaces use.
 *
 * This is the **public** maximum and it is the authority. The reader behind it clamps at this number
 * **plus one**, because the API asks for `limit + 1` to learn whether another page exists; a ceiling
 * equal to the maximum would eat that probe row and report no next page (0106). This figure must not
 * move without moving that ceiling with it.
 */
export const BLOCKS_DEFAULT_LIMIT = 20;
export const BLOCKS_MAX_LIMIT = 50;

/**
 * The reason's bound, which is 0005's `user_blocks_reason_length` restated where a form can act on it.
 *
 * The constraint remains what makes it true; this is so somebody typing gets told before they submit.
 */
export const BLOCK_REASON_MAX = 500;

/**
 * The seller slug bound, matching `StartDirectConversationRequestSchema` in the messaging contract.
 *
 * The same handle, the same bound: a slug that could start a conversation is a slug that can end one.
 */
export const BLOCK_SELLER_SLUG_MAX = 50;

/* ------------------------------------------------------------------------------------------------ */
/* Naming a person                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

const reason = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().max(BLOCK_REASON_MAX))
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

/**
 * Blocking the other participant of a conversation.
 *
 * The conversation is named, the person is not. Which participant that resolves to is decided inside one
 * SECURITY DEFINER function, which also requires the caller to be a live participant — so this shape
 * cannot be used to ask who is in a thread the caller is not in.
 */
export const BlockByConversationRequestSchema = z
  .object({
    conversationId: z.uuid(),
    reason,
  })
  .strict()
  .openapi('BlockByConversationRequest');

/**
 * Blocking a seller named by their public storefront slug.
 *
 * 0053 settled this for the messaging entry point: the surface that offers "message this seller" has no
 * account identifier to send and must not be given one, so it sends the slug and the resolution happens
 * in one definer function. The surface that offers "block this seller" is the same surface.
 */
export const BlockBySellerRequestSchema = z
  .object({
    sellerSlug: z.string().min(1).max(BLOCK_SELLER_SLUG_MAX),
    reason,
  })
  .strict()
  .openapi('BlockBySellerRequest');

/**
 * One request, one handle.
 *
 * A union rather than one object with two optional fields, because an object with two optional fields can
 * express both-at-once and neither-at-all, and both of those would need a rule invented here to resolve.
 */
export const BlockRequestSchema = z
  .union([BlockByConversationRequestSchema, BlockBySellerRequestSchema])
  .openapi('BlockRequest');

/* ------------------------------------------------------------------------------------------------ */
/* The list                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One blocked person, as their blocker sees them.
 *
 * `reference` is the opaque token the unblock takes. `displayName` and `sellerSlug` are both nullable
 * because somebody reached through a conversation may have set no name and may run no storefront — and a
 * surface showing "a blocked account" with no name is the honest rendering of that, not a bug to fill in
 * with an identifier.
 */
export const BlockedPersonSchema = z
  .object({
    reference: z.string().min(1),
    displayName: z.string().nullable(),
    sellerSlug: z.string().nullable(),
    reason: z.string().nullable(),
    blockedAt: z.iso.datetime(),
  })
  .strict()
  .openapi('BlockedPerson');

export const BlocksResponseSchema = z
  .object({
    items: z.array(BlockedPersonSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('BlocksResponse');

/**
 * What a block write did.
 *
 * `changed` is false for somebody who was already blocked and for an unblock that found nothing. Both are
 * successes, in the same sense the 7-E favorite and address writes use the word: the caller asked for a
 * state and the state holds. Pressing Block twice must not look like a failure to somebody who is
 * frightened enough to be pressing it twice.
 */
export const BlockMutationResponseSchema = z
  .object({ changed: z.boolean() })
  .strict()
  .openapi('BlockMutationResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Types                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export type BlockByConversationRequest = z.infer<typeof BlockByConversationRequestSchema>;
export type BlockBySellerRequest = z.infer<typeof BlockBySellerRequestSchema>;
export type BlockRequest = z.infer<typeof BlockRequestSchema>;
export type BlockedPerson = z.infer<typeof BlockedPersonSchema>;
export type BlocksResponse = z.infer<typeof BlocksResponseSchema>;
export type BlockMutationResponse = z.infer<typeof BlockMutationResponseSchema>;
