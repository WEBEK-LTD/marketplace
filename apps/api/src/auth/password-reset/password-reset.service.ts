import { Inject, Injectable, Logger } from '@nestjs/common';
import { PasswordSchema } from '@repo/contracts';
import { generateResetToken, isResetTokenShaped, resetTokenDigest, type ResetToken } from './reset-token.js';

/** The database operations the reset-token lifecycle needs, and nothing else. */
export interface PasswordResetTokenStore {
  issuePasswordResetToken(input: IssueResetTokenInput): Promise<IssueResetTokenRow>;
  consumePasswordResetToken(input: ConsumeResetTokenInput): Promise<ConsumeResetTokenRow>;
}

export interface IssueResetTokenInput {
  readonly userId: string;
  /** Only ever the digest. The clear token does not cross this boundary. */
  readonly tokenHash: Buffer;
  readonly requestIp: string | null;
}

export interface IssueResetTokenRow {
  readonly outcome: 'issued' | 'unknown_user';
  readonly tokenId: string | null;
  readonly expiresAt: Date | null;
}

export interface ConsumeResetTokenInput {
  readonly tokenHash: Buffer;
  readonly expectedUserId: string | null;
}

export interface ConsumeResetTokenRow {
  readonly outcome: 'consumed' | 'not_found' | 'expired' | 'already_consumed' | 'wrong_user';
  readonly userId: string | null;
  readonly tokenId: string | null;
}

export const PASSWORD_RESET_TOKEN_STORE = Symbol('PASSWORD_RESET_TOKEN_STORE');

/**
 * Why an issue did not happen, or why a token was refused.
 *
 * These are internal reason codes in the sense the F2 login flow established: the server distinguishes
 * them so it can record what happened, and the caller's caller never learns which one occurred. A
 * response built from one of these values would be exactly the enumeration channel C-18 exists to close.
 */
export type ResetIssueRefusal = 'unknown_user' | 'store_unavailable';
export type ResetConsumptionRefusal =
  | 'malformed'
  | 'not_found'
  | 'expired'
  | 'already_consumed'
  | 'wrong_user'
  | 'store_unavailable';

export type PasswordResetIssue =
  | {
      readonly status: 'issued';
      /** Clear only in this object, only in this process, only until the message is built. */
      readonly token: ResetToken;
      readonly tokenId: string;
      readonly expiresAt: Date;
    }
  | { readonly status: 'not_issued'; readonly reason: ResetIssueRefusal };

export type PasswordResetConsumption =
  | { readonly status: 'consumed'; readonly userId: string; readonly tokenId: string }
  | { readonly status: 'rejected'; readonly reason: ResetConsumptionRefusal };

export interface IssueResetRequest {
  /** Resolved by the caller; a reset is always issued for a known account or not at all. */
  readonly userId: string | null;
  readonly requestIp?: string | null;
}

export interface ConsumeResetRequest {
  /** The token exactly as it came back from the person, usually out of a reset link. */
  readonly token: string;
  /** When the caller already knows whose reset this is, the token must belong to them. */
  readonly expectedUserId?: string | null;
}

/**
 * The password-reset token lifecycle (C-18).
 *
 * This is the foundation the rest of F3 is built on, and it deliberately stops short of that rest: it
 * issues a token and it consumes one. It does not deliver anything, does not change a password, does not
 * revoke sessions and has no HTTP surface — those contracts are not approved yet, and inventing them
 * here would put policy in the wrong place.
 *
 * Three rules are enforced here rather than left to a caller.
 *
 * **The clear token exists only in the issue result.** It is generated here, wrapped in a
 * {@link ResetToken} that redacts itself in every string, JSON and inspection context, and only its
 * digest is sent to the database. Nothing logs it, nothing stores it, nothing returns it beyond the
 * caller that must build the reset link.
 *
 * **Every refusal looks the same from outside.** An unknown account, an unreachable database and a
 * successful issue all leave this service as a result the caller cannot tell apart other than by the
 * internal `reason` field, which exists for the server's own record. A future reset-request endpoint can
 * therefore answer identically in every case — which is the whole of decision "neutral response always".
 *
 * **A rejected password never burns a token.** {@link validateNewPassword} applies the approved D1
 * policy from `@repo/contracts` unchanged; the completion step validates first and consumes second, so a
 * person who types a too-short password still has their reset link.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(@Inject(PASSWORD_RESET_TOKEN_STORE) private readonly store: PasswordResetTokenStore) {}

  /**
   * Issues one reset token for a known account.
   *
   * A null `userId` is the normal shape of "no account matched" and costs a caller nothing to pass: it
   * produces the same result as an unknown account, without a database round trip that would make the
   * two distinguishable by timing at the database level.
   */
  async issue(request: IssueResetRequest): Promise<PasswordResetIssue> {
    if (request.userId === null) return { status: 'not_issued', reason: 'unknown_user' };

    const token = generateResetToken();
    let row: IssueResetTokenRow;
    try {
      row = await this.store.issuePasswordResetToken({
        userId: request.userId,
        tokenHash: token.digest(),
        requestIp: request.requestIp ?? null,
      });
    } catch (error) {
      // The reason is recorded; the answer to the caller is the same one an unknown account gets.
      this.logger.error('Issuing a password reset token failed.', errorName(error));
      return { status: 'not_issued', reason: 'store_unavailable' };
    }

    if (row.outcome !== 'issued' || row.tokenId === null || row.expiresAt === null) {
      return { status: 'not_issued', reason: 'unknown_user' };
    }
    return { status: 'issued', token, tokenId: row.tokenId, expiresAt: row.expiresAt };
  }

  /**
   * Consumes a submitted token, atomically and exactly once.
   *
   * The decision is the database's: `app_private.consume_password_reset_token` locks the row, checks
   * expiry, prior consumption and the account binding, and writes the consumption in the same statement.
   * Doing any of that here would open the window between "looks valid" and "marked used" that a
   * simultaneous second request needs.
   *
   * The caller runs this inside the transaction that performs the reset, so a failed password change
   * rolls the consumption back and the person's link still works.
   */
  async consume(request: ConsumeResetRequest): Promise<PasswordResetConsumption> {
    if (!isResetTokenShaped(request.token)) {
      // A value that cannot be a token never reaches the database.
      return { status: 'rejected', reason: 'malformed' };
    }

    let row: ConsumeResetTokenRow;
    try {
      row = await this.store.consumePasswordResetToken({
        tokenHash: resetTokenDigest(request.token),
        expectedUserId: request.expectedUserId ?? null,
      });
    } catch (error) {
      this.logger.error('Consuming a password reset token failed.', errorName(error));
      return { status: 'rejected', reason: 'store_unavailable' };
    }

    if (row.outcome === 'consumed' && row.userId !== null && row.tokenId !== null) {
      return { status: 'consumed', userId: row.userId, tokenId: row.tokenId };
    }
    // A 'consumed' outcome without an account is a contract violation, not an authorisation.
    return { status: 'rejected', reason: row.outcome === 'consumed' ? 'store_unavailable' : row.outcome };
  }

  /**
   * The approved password policy, applied unchanged.
   *
   * D1 lives in `@repo/contracts` and is shared with the web and admin apps; this method delegates to it
   * so the reset path cannot drift from registration and login. It exists here to fix the *order*: a new
   * password is validated before a token is consumed, never after.
   */
  validateNewPassword(password: string): { readonly valid: boolean; readonly issues: readonly string[] } {
    const result = PasswordSchema.safeParse(password);
    if (result.success) return { valid: true, issues: [] };
    // The stable rule identifiers D1 defines, never the messages and never the value: a caller that
    // rendered a message would decide the wording of a policy it does not own.
    const issues = result.error.issues.map((issue) => {
      const rule = (issue as { params?: { rule?: unknown } }).params?.rule;
      return typeof rule === 'string' ? rule : 'password_invalid';
    });
    return { valid: false, issues };
  }
}

/**
 * What may be written about a failure: its type, never its payload.
 *
 * A driver error can carry the statement it failed on. The statement carries the digest — and a
 * digest is not a token, but it is still material this service has no reason to put in a log.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
