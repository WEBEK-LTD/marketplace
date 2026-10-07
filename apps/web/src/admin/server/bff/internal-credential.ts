import 'server-only';

/**
 * The header the BFF presents on every `/v1` call (owner decision C-2d).
 *
 * The name is repeated here rather than imported from the API or from `@repo/contracts`: the API is a
 * separate application this app may not import, and the contracts package must never learn about the
 * credential, because it is the package the browser-facing code depends on. `bff-credential.test.ts`
 * pins the literal so the two sides cannot drift apart silently.
 */
export const INTERNAL_CREDENTIAL_HEADER = 'x-internal-credential';

/**
 * Wraps `fetch` so that every request the generated API client makes carries the internal credential.
 *
 * **This is a transport boundary, not authentication.** The credential says "an approved internal
 * runtime is calling"; it authorizes nothing about a user, and the API checks user identity and
 * permissions separately. Possession of it alone must never be enough to act as someone.
 *
 * The credential is a closure variable, never a module-level value and never attached to the returned
 * function as a property, so there is nothing for a caller or a serializer to read back out. The header
 * is set last, after the caller's own `init.headers`, so no call site can override or remove it.
 *
 * This file is `server-only`: importing it from a client component is a build error, which is what
 * keeps the credential out of the browser bundle.
 */
export function createInternalCredentialFetch(credential: string, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(INTERNAL_CREDENTIAL_HEADER, credential);
    return base(input, { ...init, headers });
  };
}
