import { describe, expect, it } from 'vitest';
import {
  STAFF_ROLE_REASON_MAX,
  StaffGrantableRolesResponseSchema,
  StaffRoleGrantRequestSchema,
  StaffRoleReasonSchema,
  StaffRoleRevokeRequestSchema,
  StaffRoleWriteResponseSchema,
} from '../src/index.js';

/**
 * The staff role contracts (0100).
 *
 * These schemas guard the most privilege-sensitive writer the platform has, so what matters here is not only
 * what they accept but what they **cannot carry**: there is no field in either request that could widen which
 * roles the caller may grant, name a different account than the path does, set an actor, or reach the role
 * catalogue. Both are `.strict()`, which is what makes that a property rather than an intention.
 *
 * The reason is required on both operations and `trim().min(1)`, so whitespace is not a reason. The database
 * applies the same test against the same whitespace set; this is the path and that is the floor.
 */

const ACTOR = '11111111-1111-4111-8111-111111111111';

describe('StaffRoleReasonSchema', () => {
  it('accepts a sentence', () => {
    expect(StaffRoleReasonSchema.safeParse('Joining the trust and safety rota').success).toBe(true);
  });

  it('trims and keeps what is left', () => {
    expect(StaffRoleReasonSchema.parse('  Joining the rota  ')).toBe('Joining the rota');
  });

  it('refuses nothing, emptiness, and every shape of whitespace', () => {
    for (const value of ['', ' ', '   ', '\t', '\n', '\r\n', '\t\n ', '   ']) {
      expect(StaffRoleReasonSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it('refuses a reason longer than the bound', () => {
    expect(StaffRoleReasonSchema.safeParse('a'.repeat(STAFF_ROLE_REASON_MAX)).success).toBe(true);
    expect(StaffRoleReasonSchema.safeParse('a'.repeat(STAFF_ROLE_REASON_MAX + 1)).success).toBe(false);
  });

  it('refuses anything that is not a string', () => {
    for (const value of [42, true, null, undefined, {}, []]) {
      expect(StaffRoleReasonSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('StaffRoleGrantRequestSchema', () => {
  it('accepts a role and a reason', () => {
    expect(
      StaffRoleGrantRequestSchema.safeParse({ roleKey: 'moderator', reason: 'On the rota' }).success,
    ).toBe(true);
  });

  it('accepts an expiry, and an explicit null for none', () => {
    expect(
      StaffRoleGrantRequestSchema.safeParse({
        roleKey: 'moderator',
        reason: 'Cover',
        expiresAt: '2027-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      StaffRoleGrantRequestSchema.safeParse({ roleKey: 'moderator', reason: 'Cover', expiresAt: null })
        .success,
    ).toBe(true);
  });

  it('refuses an expiry that is not a timestamp', () => {
    for (const expiresAt of ['soon', '2027-01-01', 1800000000, true]) {
      expect(
        StaffRoleGrantRequestSchema.safeParse({ roleKey: 'moderator', reason: 'Cover', expiresAt })
          .success,
        JSON.stringify(expiresAt),
      ).toBe(false);
    }
  });

  it('requires the role and the reason', () => {
    expect(StaffRoleGrantRequestSchema.safeParse({ reason: 'On the rota' }).success).toBe(false);
    expect(StaffRoleGrantRequestSchema.safeParse({ roleKey: 'moderator' }).success).toBe(false);
    expect(StaffRoleGrantRequestSchema.safeParse({}).success).toBe(false);
  });

  it('refuses a blank role key', () => {
    for (const roleKey of ['', '   ', '\t']) {
      expect(
        StaffRoleGrantRequestSchema.safeParse({ roleKey, reason: 'On the rota' }).success,
        JSON.stringify(roleKey),
      ).toBe(false);
    }
  });

  /**
   * The point of `.strict()` here. None of these fields exists, and each of them is something a crafted
   * request might try: naming another account, claiming to be the actor, reaching the catalogue's own columns,
   * or undoing a withdrawal directly.
   */
  it('carries no field that could widen the request', () => {
    for (const extra of [
      { userId: ACTOR },
      { targetUserId: ACTOR },
      { grantedBy: ACTOR },
      { revokedBy: ACTOR },
      { revokedAt: null },
      { grantedAt: '2026-01-01T00:00:00.000Z' },
      { sortOrder: 7 },
      { isAssignable: true },
      { requiresMfa: false },
      { permissionKey: 'users.role.manage' },
      { permissions: ['users.role.manage'] },
      { ceiling: 7 },
    ]) {
      expect(
        StaffRoleGrantRequestSchema.safeParse({ roleKey: 'moderator', reason: 'On the rota', ...extra })
          .success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe('StaffRoleRevokeRequestSchema', () => {
  it('accepts a role and a reason, and nothing else', () => {
    expect(
      StaffRoleRevokeRequestSchema.safeParse({ roleKey: 'moderator', reason: 'Left the rota' }).success,
    ).toBe(true);
    expect(
      StaffRoleRevokeRequestSchema.safeParse({ roleKey: 'moderator', reason: 'Left', expiresAt: null })
        .success,
    ).toBe(false);
  });

  it('requires a reason, as the grant does', () => {
    expect(StaffRoleRevokeRequestSchema.safeParse({ roleKey: 'moderator' }).success).toBe(false);
    expect(StaffRoleRevokeRequestSchema.safeParse({ roleKey: 'moderator', reason: '  ' }).success).toBe(
      false,
    );
  });

  /** There is deliberately no field here that could turn a withdrawal into a deletion. */
  it('carries nothing that could delete a grant', () => {
    for (const extra of [{ delete: true }, { hard: true }, { purge: true }, { revokedAt: null }]) {
      expect(
        StaffRoleRevokeRequestSchema.safeParse({ roleKey: 'moderator', reason: 'Left', ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe('the responses', () => {
  it('reports which of the two operations happened', () => {
    expect(StaffRoleWriteResponseSchema.safeParse({ outcome: 'granted', roleKey: 'moderator' }).success).toBe(
      true,
    );
    expect(StaffRoleWriteResponseSchema.safeParse({ outcome: 'revoked', roleKey: 'moderator' }).success).toBe(
      true,
    );
    expect(StaffRoleWriteResponseSchema.safeParse({ outcome: 'deleted', roleKey: 'moderator' }).success).toBe(
      false,
    );
  });

  it('reports no actor and no reason on the way back either', () => {
    expect(
      StaffRoleWriteResponseSchema.safeParse({
        outcome: 'granted',
        roleKey: 'moderator',
        grantedBy: ACTOR,
      }).success,
    ).toBe(false);
    expect(
      StaffRoleWriteResponseSchema.safeParse({ outcome: 'granted', roleKey: 'moderator', reason: 'x' })
        .success,
    ).toBe(false);
  });

  it('describes a grantable role without saying anything about the caller', () => {
    expect(
      StaffGrantableRolesResponseSchema.safeParse({
        items: [
          {
            roleKey: 'moderator',
            nameEn: 'Moderator',
            nameAr: 'مشرف',
            requiresMfa: true,
            isAdminConsole: true,
          },
        ],
      }).success,
    ).toBe(true);
    // No ceiling, no sort order, no permission list: the set is the answer, not the rule that produced it.
    expect(
      StaffGrantableRolesResponseSchema.safeParse({
        items: [
          {
            roleKey: 'moderator',
            nameEn: 'Moderator',
            nameAr: 'مشرف',
            requiresMfa: true,
            isAdminConsole: true,
            sortOrder: 4,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts an empty set, which is what a caller with no ceiling receives', () => {
    expect(StaffGrantableRolesResponseSchema.safeParse({ items: [] }).success).toBe(true);
  });
});
