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

/**
 * Hashes a client IP for the throttle buckets and the security-event payload (C-1, C-20).
 *
 * Same reasoning as {@link hashIdentifier}: the counter needs a stable key per client, not the address
 * itself, and a security event records a pseudonymous IP rather than a real one. Absent or blank yields
 * null, which the callers treat as "no IP bucket for this request" rather than as a shared empty key —
 * lumping every unknown-IP request into one bucket would let one client throttle everyone.
 */
export function hashClientIp(ip: string | undefined | null): Buffer | null {
  if (ip === undefined || ip === null) return null;
  const trimmed = ip.trim();
  if (trimmed === '') return null;
  return createHash('sha256').update(trimmed, 'utf8').digest();
}

/** Hashes a user agent for `login_attempts.user_agent_hash`. Absent or blank yields null. */
export function hashUserAgent(userAgent: string | undefined | null): Buffer | null {
  if (userAgent === undefined || userAgent === null) return null;
  const trimmed = userAgent.trim();
  if (trimmed === '') return null;
  return createHash('sha256').update(trimmed, 'utf8').digest();
}
