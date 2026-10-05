import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request- and job-scoped log identity (O8-12).
 *
 * The pseudonymous user identifier has to appear on *every* line a request or a job writes, including
 * lines written deep inside a service that knows nothing about who is calling. Threading a field
 * through every call signature would be both invasive and unreliable — one missed call site and the
 * correlation has a hole.
 *
 * So the value lives in an `AsyncLocalStorage` scope that is entered once per request and once per job,
 * exactly as the request span is entered in `registerRequestTracing`, and the logger's `mixin` reads it
 * on each line. A child logger created inside the scope inherits it for free, because the mixin runs per
 * record rather than per logger.
 *
 * **This module never sees the key.** It stores an already-derived identifier and nothing else. The
 * derivation and the secret live in `@repo/server-config`, which is where a secret belongs; telemetry
 * code cannot leak a key it was never given.
 *
 * Nothing here reaches OpenTelemetry. Span attributes are governed by the sanitiser and its allowlist,
 * which does not permit identity-like attributes, so the identifier stays in logs only.
 */

export interface LogIdentityScope {
  /** Set once, when a request or job resolves who it is acting for. Absent until then. */
  userPseudoId?: string;
}

const storage = new AsyncLocalStorage<LogIdentityScope>();

/**
 * Runs `body` in a fresh scope. Entered before anything can resolve an identity, so that a later
 * {@link setLogIdentity} has somewhere to write.
 *
 * The callback form matters: everything awaited inside it stays in the scope, and the scope ends with
 * it, so one request can never see another's identity.
 */
export function runInLogIdentityScope<T>(body: () => T): T {
  return storage.run({}, body);
}

/**
 * Records the identity of the current request or job.
 *
 * Outside a scope this does nothing. That is deliberate: a service called from a unit test or a
 * start-up path must not throw because there is no request around it, and logging is never allowed to
 * be the reason an operation fails.
 */
export function setLogIdentity(userPseudoId: string | undefined): void {
  const scope = storage.getStore();
  if (scope === undefined || typeof userPseudoId !== 'string' || userPseudoId === '') return;
  scope.userPseudoId = userPseudoId;
}

/** The identity fields for one log record. Empty outside a scope and before an identity is known. */
export function activeLogIdentityFields(): { user_pseudo_id?: string } {
  const pseudoId = storage.getStore()?.userPseudoId;
  return pseudoId === undefined ? {} : { user_pseudo_id: pseudoId };
}

/** The current scope, for tests that need to assert what was recorded. */
export function currentLogIdentity(): string | undefined {
  return storage.getStore()?.userPseudoId;
}
