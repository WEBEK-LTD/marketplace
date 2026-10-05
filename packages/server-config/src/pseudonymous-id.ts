import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The pseudonymous user identifier used for log correlation (owner decision C-13, observability O8-12).
 *
 * A server log needs to say "these twenty lines are the same person" without saying who that person is.
 * The raw `auth.users.id` would do the first job and fail the second: it is the join key to every table
 * in the system, so a leaked log would be a leaked user graph.
 *
 * So the identifier is a keyed MAC, not a hash:
 *
 *   usr_ || base64url( HMAC-SHA-256( key, "log-user-v1:" || canonical UUID ) )
 *
 * **Why HMAC and not SHA-256.** A UUID has no entropy an attacker lacks — given a plain
 * `sha256(user_id)` and a list of candidate UUIDs, anyone can test them one by one until a digest
 * matches, and a leaked log becomes a leaked identity map. The key is what they do not have. C-13 is
 * explicit that a plain or unsalted hash is not acceptable here.
 *
 * This is deliberately **not** the same construction as `subject-hash.ts` in the API, which stores
 * unsalted SHA-256 digests of identifiers in `app_private.login_attempts`. That one must be stable
 * without a secret because the database is the thing correlating rows, and its inputs (an email, an IP)
 * are not the join key to the whole schema. Neither construction is the right answer to the other's
 * problem, and this file changes nothing about that one.
 *
 * **Scope of the correlation.** One key per environment: the same UUID yields the same identifier in the
 * API and in the worker, which is the point, and a different identifier in staging than in production,
 * which is also the point — C-13 does not ask for cross-environment correlation, and a shared key would
 * make a staging log disclose production identities.
 *
 * **Domain separation.** The MAC input is prefixed with a fixed, versioned label so that the same key
 * could never produce the same value for a different kind of subject, and so a future v2 construction
 * can coexist with this one instead of silently colliding with it.
 *
 * The identifier is for log correlation only. It is not a credential, it is not accepted as API input,
 * and it is never a lookup key for a privileged operation.
 */

/** The versioned domain-separation label. Part of the contract: changing it changes every identifier. */
export const PSEUDONYMOUS_ID_DOMAIN = 'log-user-v1:';

/** Marks the value as a pseudonym wherever it is read, so nobody mistakes it for a UUID. */
export const PSEUDONYMOUS_ID_PREFIX = 'usr_';

/** The field name every service uses. One name, so log queries work across the API and the worker. */
export const PSEUDONYMOUS_ID_FIELD = 'user_pseudo_id';

/**
 * Shortest key accepted. The key's only job is to be unguessable, so this is a floor against a
 * misconfigured deployment ("changeme"), not a substitute for generating it randomly.
 */
export const MIN_PSEUDONYMOUS_KEY_LENGTH = 32;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What is written where a key would otherwise be printed. */
const REDACTED = '[REDACTED]';

/**
 * Holds the pseudonymous-ID key and is the only thing that can use it.
 *
 * The key lives in a private field, so it cannot be read back off the instance, and `toString`,
 * `toJSON` and the inspect hook all answer `[REDACTED]`. That matters because this object is passed
 * around logging code: an instance that accidentally reaches a log line, an error message or a JSON
 * response prints nothing.
 */
export class PseudonymousUserId {
  readonly #key: Buffer;

  constructor(key: string) {
    if (typeof key !== 'string' || key.length < MIN_PSEUDONYMOUS_KEY_LENGTH) {
      // The value is never named in the message.
      throw new RangeError(`The pseudonymous user ID key must be at least ${MIN_PSEUDONYMOUS_KEY_LENGTH} characters.`);
    }
    this.#key = Buffer.from(key, 'utf8');
  }

  /**
   * The pseudonymous identifier for one user.
   *
   * Throws for anything that is not a canonical UUID: a caller that does not have a resolved user has
   * nothing to derive from, and inventing a value would put a fake identity in the log. Use
   * {@link forUser} on any path where that is a possibility rather than a bug.
   */
  derive(userId: string): string {
    const canonical = typeof userId === 'string' ? userId.trim().toLowerCase() : '';
    if (!UUID_PATTERN.test(canonical)) {
      throw new RangeError('A canonical user UUID is required to derive a pseudonymous identifier.');
    }
    const mac = createHmac('sha256', this.#key)
      .update(`${PSEUDONYMOUS_ID_DOMAIN}${canonical}`, 'utf8')
      // base64url, and Node emits it without padding — so the identifier is URL- and log-safe.
      .digest('base64url');
    return `${PSEUDONYMOUS_ID_PREFIX}${mac}`;
  }

  /**
   * The same thing, for places where the user may legitimately be absent: a job with no user, an
   * anonymous request. Returns undefined rather than a placeholder, because a placeholder in an
   * identity field is worse than no field at all — it can be mistaken for a real identity.
   */
  forUser(userId: unknown): string | undefined {
    if (typeof userId !== 'string') return undefined;
    try {
      return this.derive(userId);
    } catch {
      return undefined;
    }
  }

  /** True when `candidate` is this key's identifier for `userId`. For tests and nothing else. */
  matches(userId: string, candidate: string): boolean {
    const expected = Buffer.from(this.derive(userId), 'utf8');
    const given = Buffer.from(candidate, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}
