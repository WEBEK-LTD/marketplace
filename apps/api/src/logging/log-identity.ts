import { setLogIdentity } from '@repo/telemetry';
import type { PseudonymousUserId } from '@repo/server-config';

/** Injection token for the pseudonymous-ID key (C-13). Provided once, from the API environment. */
export const PSEUDONYMOUS_USER_ID = Symbol('PSEUDONYMOUS_USER_ID');

/**
 * Names the current request's user in the log context, pseudonymously (C-13, O8-12).
 *
 * This is the whole of what a service adds. It records nothing itself, changes no behaviour and cannot
 * fail the operation around it: an unusable user value simply leaves the field off, and outside a
 * request scope the call does nothing at all.
 *
 * The raw UUID is not logged here or anywhere else — it goes in, and only the derived identifier comes
 * out. A log line therefore carries the pseudonym or nothing, never both forms of the same identity.
 */
export function recordLogIdentity(pseudonymous: PseudonymousUserId, userId: unknown): void {
  setLogIdentity(pseudonymous.forUser(userId));
}
