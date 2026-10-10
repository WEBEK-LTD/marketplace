'use client';

import { useState, type FormEvent } from 'react';
import { ADMIN_BUTTON, ADMIN_FIELD } from '../ui';

/**
 * The admin sign-in form. It is the web form's twin rather than a shared component: the two apps may
 * not import each other, they are separate origins, and their sessions must stay separate.
 *
 * Every string arrives as a prop, like the other components in this app, because the client bundle is
 * given only the `Error` messages by the root layout.
 *
 * There is exactly one failure message for a refused sign-in. C-2 gives wrong password, unknown
 * identifier and locked account the same status and the same body, and this screen keeps that promise
 * on the browser side: it maps the **status** to a sentence and never reads the response body, so no
 * internal reason code, lockout state or account-existence hint can reach the page even if a future
 * change added one to the payload.
 */
export interface LoginFormLabels {
  readonly identifier: string;
  readonly identifierHint: string;
  readonly password: string;
  readonly submit: string;
  readonly submitting: string;
  /** Shown when a field is empty. Client-side convenience only; the server decides. */
  readonly incomplete: string;
  /** The approved generic authentication failure (401). */
  readonly failed: string;
  /** 400 — the server rejected the request as invalid. */
  readonly invalid: string;
  /** 429 — the C-1 throttle refused the request. */
  readonly throttled: string;
  /** 503 — provider or infrastructure failure. */
  readonly unavailable: string;
}

export interface LoginFormProps {
  readonly labels: LoginFormLabels;
  /** The BFF route on this origin. Never the API and never Supabase. */
  readonly action: string;
  /** Where to go once the session cookies are set. */
  readonly successHref: string;
}

const FIELD_CLASS = `mt-1 ${ADMIN_FIELD} text-base`;

export function LoginForm({ labels, action, successHref }: LoginFormProps) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    if (identifier.trim() === '' || password === '') {
      setMessage(labels.incomplete);
      return;
    }

    setPending(true);
    try {
      // Same-origin only: the browser posts here, the BFF posts to the API, and the API is the only
      // thing that ever speaks to Supabase.
      const response = await fetch(action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim(), password }),
      });

      if (response.status === 200) {
        // A full page navigation rather than a client-side route change: the session lives in cookies
        // the browser has just been given, and every subsequent request must carry them.
        setPassword('');
        globalThis.location.assign(successHref);
        return;
      }
      // The status alone decides the sentence. The body is never read.
      setMessage(loginMessageFor(response.status, labels));
    } catch {
      // A network failure is indistinguishable from an unavailable service, and is told as one.
      setMessage(labels.unavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-8 max-w-sm">
      <p aria-live="polite" role="status" className="min-h-6 text-sm text-ink-strong">
        {message}
      </p>

      <div className="mt-4">
        <label htmlFor="login-identifier" className="block text-sm font-medium text-ink-strong">
          {labels.identifier}
        </label>
        <input
          id="login-identifier"
          name="identifier"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-describedby="login-identifier-hint"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          className={FIELD_CLASS}
        />
        <p id="login-identifier-hint" className="mt-1 text-sm text-ink-muted">
          {labels.identifierHint}
        </p>
      </div>

      <div className="mt-4">
        <label htmlFor="login-password" className="block text-sm font-medium text-ink-strong">
          {labels.password}
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={FIELD_CLASS}
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className={`${ADMIN_BUTTON} mt-6 disabled:opacity-60`}
      >
        {pending ? labels.submitting : labels.submit}
      </button>
    </form>
  );
}

/**
 * The complete status-to-sentence map, exported so a test can pin it.
 *
 * 401 is one sentence for every refused sign-in, and anything unexpected is told as an unavailable
 * service rather than as a detail about the account.
 */
export function loginMessageFor(status: number, labels: LoginFormLabels): string {
  if (status === 400) return labels.invalid;
  if (status === 401) return labels.failed;
  if (status === 429) return labels.throttled;
  return labels.unavailable;
}
