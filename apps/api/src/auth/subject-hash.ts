import { createHash } from 'node:crypto';

/**
 * Login identifiers and user agents are hashed before they reach the database.
 *
 * `app_private.login_attempts` stores `identifier_hash` and `user_agent_hash` as `bytea` for a reason:
 * the table is a record of failed sign-in attempts, so it accumulates exactly the values an attacker
 * would want — email addresses and phone numbers that do and do not exist. Hashing here means a leak of
 * the table is not a leak of the identifiers.
 *
 * The hash is unsalted on purpose. It must be stable across processes and restarts so that attempts for
 * the same identifier group together, which a per-process salt would break. It is a correlation key, not
 * a password digest, and it is never compared against a user-supplied hash.
 */
export function hashIdentifier(identifier: string): Buffer {
  const normalized = identifier.trim().toLowerCase();
  if (normalized === '') throw new RangeError('identifier must not be blank.');
  return createHash('sha256').update(normalized, 'utf8').digest();
}

/** Hashes a user agent for `login_attempts.user_agent_hash`. Absent or blank yields null. */
export function hashUserAgent(userAgent: string | undefined | null): Buffer | null {
  if (userAgent === undefined || userAgent === null) return null;
  const trimmed = userAgent.trim();
  if (trimmed === '') return null;
  return createHash('sha256').update(trimmed, 'utf8').digest();
}
