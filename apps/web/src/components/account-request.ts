/**
 * The one way the buyer account surfaces talk to their own origin (Phase 7-E).
 *
 * Every form and every button below goes through this. It sends same-origin credentials so the session
 * cookie travels, reads **only the status and the problem code** of the answer, and never touches a
 * token: the session is an `HttpOnly` cookie this code cannot see, and the account the server acts on is
 * resolved from it, never named here.
 *
 * The problem code is read because these surfaces have refusals a person can act on — a name already
 * taken, a country that cannot be shipped to, a row that is no longer there. Everything else collapses
 * into one failure, because "something went wrong, try again" is the whole of what a page can honestly
 * say about the rest.
 */

export type AccountOutcome =
  | { readonly status: 'ok'; readonly body: unknown }
  | { readonly status: 'invalid'; readonly code: string | null; readonly field: string | null }
  | { readonly status: 'conflict'; readonly code: string | null }
  | { readonly status: 'missing' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'failed' };

interface ProblemBody {
  readonly code?: unknown;
  readonly errors?: unknown;
}

/** The first field a refusal named, when it named one. Used to point a form at the right input. */
function firstField(body: ProblemBody): string | null {
  if (!Array.isArray(body.errors)) return null;
  const first = body.errors[0] as { path?: unknown } | undefined;
  return typeof first?.path === 'string' ? first.path : null;
}

export async function accountRequest(
  path: string,
  init: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown },
): Promise<AccountOutcome> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method,
      credentials: 'same-origin',
      ...(init.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
    });
  } catch {
    return { status: 'failed' };
  }

  if (response.status === 200 || response.status === 201) {
    try {
      return { status: 'ok', body: await response.json() };
    } catch {
      return { status: 'ok', body: null };
    }
  }

  let body: ProblemBody = {};
  try {
    body = (await response.json()) as ProblemBody;
  } catch {
    body = {};
  }
  const code = typeof body.code === 'string' ? body.code : null;

  if (response.status === 401) return { status: 'signed-out' };
  if (response.status === 404) return { status: 'missing' };
  if (response.status === 409) return { status: 'conflict', code };
  if (response.status === 400) return { status: 'invalid', code, field: firstField(body) };
  return { status: 'failed' };
}
