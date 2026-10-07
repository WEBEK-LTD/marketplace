import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_CODES } from '../src/problem-details.js';
import {
  BLOCKS_DEFAULT_LIMIT,
  BLOCKS_MAX_LIMIT,
  BLOCK_REASON_MAX,
  BLOCK_SELLER_SLUG_MAX,
  BlockByConversationRequestSchema,
  BlockBySellerRequestSchema,
  BlockMutationResponseSchema,
  BlockRequestSchema,
  BlockedPersonSchema,
  BlocksResponseSchema,
} from '../src/blocks.js';

/**
 * The blocking contract (0103).
 *
 * The whole point of these shapes is what they cannot express, so most of this file is refusal. Three
 * properties carry the increment:
 *
 *   * **no shape accepts or returns an account identifier** — asserted field by field and then again over
 *     the module's source, because a field added later would pass every individual test above it;
 *   * **exactly one handle per request** — both and neither are refused by the union itself, not by a rule
 *     applied afterwards;
 *   * **nothing here is a reverse lookup, a moderation view or a count** — there is no schema for any of
 *     them, which is the only way a contract can promise their absence.
 */

const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';

/** The module's own source, comments stripped, so prose about identifiers cannot satisfy a guard below. */
const SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'blocks.ts'), 'utf8');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ------------------------------------------------------------------------------------------------ */

describe('naming the person to block', () => {
  it('accepts a conversation on its own', () => {
    const parsed = BlockRequestSchema.safeParse({ conversationId: CONVERSATION });
    expect(parsed.success).toBe(true);
  });

  it('accepts a seller slug on its own', () => {
    const parsed = BlockRequestSchema.safeParse({ sellerSlug: 'good-shop' });
    expect(parsed.success).toBe(true);
  });

  it('refuses both handles at once, rather than choosing between them', () => {
    const parsed = BlockRequestSchema.safeParse({
      conversationId: CONVERSATION,
      sellerSlug: 'good-shop',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses neither', () => {
    expect(BlockRequestSchema.safeParse({}).success).toBe(false);
    expect(BlockRequestSchema.safeParse({ reason: 'because' }).success).toBe(false);
  });

  /** The field that must not exist, under every name somebody might reach for. */
  it('refuses a request that names an account', () => {
    for (const extra of [
      { userId: ACCOUNT },
      { blockedUserId: ACCOUNT },
      { blockedId: ACCOUNT },
      { accountId: ACCOUNT },
      { targetUserId: ACCOUNT },
    ]) {
      expect(BlockRequestSchema.safeParse({ ...extra }).success, JSON.stringify(extra)).toBe(false);
      expect(
        BlockRequestSchema.safeParse({ sellerSlug: 'good-shop', ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('refuses anything else alongside a valid handle, because both arms are strict', () => {
    for (const extra of [{ aal: 2 }, { permission: 'x' }, { notify: true }, { severity: 'high' }]) {
      expect(
        BlockRequestSchema.safeParse({ conversationId: CONVERSATION, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('refuses a conversation that is not an identifier', () => {
    for (const value of ['', 'not-a-uuid', CONVERSATION.toUpperCase().replace(/-/g, ''), 42, null]) {
      expect(
        BlockByConversationRequestSchema.safeParse({ conversationId: value }).success,
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  it('refuses an empty slug and one longer than the messaging contract allows', () => {
    expect(BlockBySellerRequestSchema.safeParse({ sellerSlug: '' }).success).toBe(false);
    expect(
      BlockBySellerRequestSchema.safeParse({ sellerSlug: 'x'.repeat(BLOCK_SELLER_SLUG_MAX) }).success,
    ).toBe(true);
    expect(
      BlockBySellerRequestSchema.safeParse({ sellerSlug: 'x'.repeat(BLOCK_SELLER_SLUG_MAX + 1) }).success,
    ).toBe(false);
  });
});

describe('the reason', () => {
  it('is optional, because somebody protecting themselves need not justify it', () => {
    expect(BlockBySellerRequestSchema.safeParse({ sellerSlug: 'good-shop' }).success).toBe(true);
    expect(BlockBySellerRequestSchema.safeParse({ sellerSlug: 'good-shop', reason: null }).success).toBe(
      true,
    );
  });

  it('is trimmed, and a reason of only whitespace becomes none at all', () => {
    const parsed = BlockBySellerRequestSchema.parse({ sellerSlug: 'good-shop', reason: '  rude  ' });
    expect(parsed.reason).toBe('rude');
    expect(BlockBySellerRequestSchema.parse({ sellerSlug: 'good-shop', reason: '   ' }).reason).toBeNull();
  });

  it('stops at the bound migration 0005 already enforces', () => {
    expect(BLOCK_REASON_MAX).toBe(500);
    expect(
      BlockBySellerRequestSchema.safeParse({ sellerSlug: 'good-shop', reason: 'x'.repeat(500) }).success,
    ).toBe(true);
    expect(
      BlockBySellerRequestSchema.safeParse({ sellerSlug: 'good-shop', reason: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
});

describe('the blocked person, as their blocker sees them', () => {
  const PERSON = {
    reference: 'YnIxfDIyMjIyMjIyLTIyMjItNDIyMi04MjIyLTIyMjIyMjIyMjIyMg',
    displayName: 'Sally Seller',
    sellerSlug: 'good-shop',
    reason: 'rude',
    blockedAt: '2026-10-03T10:00:00.000Z',
  };

  it('accepts a complete row', () => {
    expect(BlockedPersonSchema.safeParse(PERSON).success).toBe(true);
  });

  it('accepts somebody with no name, no storefront and no reason', () => {
    const parsed = BlockedPersonSchema.safeParse({
      ...PERSON,
      displayName: null,
      sellerSlug: null,
      reason: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a row carrying an account identifier under any name', () => {
    for (const extra of [
      { blockedUserId: ACCOUNT },
      { userId: ACCOUNT },
      { blockedId: ACCOUNT },
      { id: ACCOUNT },
      { email: 'someone@example.test' },
      { phoneE164: '+201000000001' },
    ]) {
      expect(BlockedPersonSchema.safeParse({ ...PERSON, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it('refuses a row carrying anything about what they did or what state they are in', () => {
    for (const extra of [
      { status: 'suspended' },
      { reportCount: 2 },
      { blockedMeBack: true },
      { lastSeenAt: '2026-10-03T10:00:00.000Z' },
    ]) {
      expect(BlockedPersonSchema.safeParse({ ...PERSON, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it('requires a reference, because without one the row cannot be acted on', () => {
    expect(BlockedPersonSchema.safeParse({ ...PERSON, reference: '' }).success).toBe(false);
    expect(BlockedPersonSchema.safeParse({ ...PERSON, reference: undefined }).success).toBe(false);
  });

  it('pages the way every other account list does', () => {
    expect(BlocksResponseSchema.safeParse({ items: [PERSON], nextCursor: null }).success).toBe(true);
    expect(BlocksResponseSchema.safeParse({ items: [], nextCursor: 'YmwxfHg' }).success).toBe(true);
    expect(BlocksResponseSchema.safeParse({ items: [PERSON] }).success).toBe(false);
  });

  it('refuses a response carrying a total, which is the shape a cap would need', () => {
    expect(
      BlocksResponseSchema.safeParse({ items: [PERSON], nextCursor: null, total: 1 }).success,
    ).toBe(false);
    expect(
      BlocksResponseSchema.safeParse({ items: [PERSON], nextCursor: null, remaining: 49 }).success,
    ).toBe(false);
  });
});

describe('what a write reports', () => {
  it('is whether anything changed, and nothing else', () => {
    expect(BlockMutationResponseSchema.safeParse({ changed: true }).success).toBe(true);
    expect(BlockMutationResponseSchema.safeParse({ changed: false }).success).toBe(true);
    expect(BlockMutationResponseSchema.safeParse({}).success).toBe(false);
  });

  it('refuses a response that names who was blocked or tells the caller they were notified', () => {
    for (const extra of [
      { blockedUserId: ACCOUNT },
      { reference: 'x' },
      { notified: true },
      { count: 1 },
    ]) {
      expect(
        BlockMutationResponseSchema.safeParse({ changed: true, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe('the module itself', () => {
  it('declares no field named after an account, anywhere', () => {
    for (const name of ['userId', 'blockedUserId', 'blockedId', 'accountId', 'blockerId']) {
      expect(CODE, name).not.toContain(name);
    }
  });

  it('declares no reverse lookup, moderation view, cap or notification shape', () => {
    for (const name of [
      'BlockedBy',
      'WhoBlocked',
      'Moderation',
      'StaffBlock',
      'BlockCount',
      'BlockLimit',
      'Notify',
    ]) {
      expect(CODE, name).not.toContain(name);
    }
  });

  it('introduces no permission key', () => {
    expect(CODE).not.toContain('permission');
    expect(CODE).not.toMatch(/'[a-z]+\.[a-z]+\.(read|write|manage)'/);
  });

  it('depends on no money contract, because a block is not a transaction', () => {
    expect(SOURCE).not.toContain('@repo/money');
    expect(CODE).not.toContain('Minor');
    expect(CODE).not.toContain('currency');
  });

  it('pages at the same sizes as the rest of the account surfaces', () => {
    expect(BLOCKS_DEFAULT_LIMIT).toBe(20);
    expect(BLOCKS_MAX_LIMIT).toBe(50);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The two decisions this increment was closed on                                                    */
/* ------------------------------------------------------------------------------------------------ */

describe('the recorded decisions', () => {
  /**
   * **No new cursor problem code.** The block list refuses an unusable cursor with the code 7-E already
   * defines for every account-list cursor, for 7-E's own stated reason: the remedy is identical in every
   * case, and naming which structural check failed would only help somebody mapping the format. A
   * `BUYER_BLOCKS_CURSOR_INVALID` was considered and deliberately not added, so this asserts the absence
   * rather than the presence — the presence is asserted where the route answers, in the API suite.
   */
  it('adds no block-specific cursor code to the platform vocabulary', () => {
    expect(PROBLEM_CODES).toContain('ACCOUNT_CURSOR_INVALID');
    for (const code of PROBLEM_CODES) {
      expect(code, code).not.toMatch(/(BLOCK.*CURSOR|CURSOR.*BLOCK)/);
    }
  });

  /** And the three refusals 0103 finally made reachable are untouched. */
  it('keeps the three existing block refusals exactly as they were', () => {
    for (const code of ['MESSAGING_BLOCKED', 'OFFER_BLOCKED', 'SERVICE_REQUEST_BLOCKED']) {
      expect(PROBLEM_CODES, code).toContain(code);
    }
  });

  /**
   * **The unblock reference is an opaque token, not an identifier.** The contract names it `reference` and
   * types it as a bounded string with no format, so nothing downstream can come to depend on it being a uuid
   * — which is what would happen first if somebody later added a surrogate key to `public.user_blocks`. That
   * the table still has no such column is asserted in the pgTAP suite; this is the contract half of the
   * same decision.
   */
  it('types the unblock reference as opaque text, never as an identifier', () => {
    expect(CODE).toContain('reference: z.string()');
    expect(CODE).not.toContain('reference: z.uuid()');
    // And a uuid is not accepted as a reference by shape, because the field carries no format at all.
    expect(BlockedPersonSchema.safeParse({
      reference: ACCOUNT,
      displayName: null,
      sellerSlug: null,
      reason: null,
      blockedAt: '2026-10-03T10:00:00.000Z',
    }).success).toBe(true);
  });
});
