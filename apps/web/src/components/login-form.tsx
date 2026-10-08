'use client';

import { Alert, Button, FormField, Input, fieldAria } from '@repo/ui';
import { useState, type FormEvent } from 'react';

/**
 * Every string the form can show. They arrive as props, like the other components in this app, because
 * the client bundle is given only the `Error` messages by the root layout.
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
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {/*
        One message region, at the top of the form, for every refusal.

        It stays mounted whether or not there is a message, because a live region inserted at the same moment as
        its content is frequently not announced at all. It is `polite` rather than `assertive` on purpose: a
        refused sign-in is an expected outcome and C-2 keeps the sentence generic, so interrupting is the wrong
        register. The `Alert` inside it defers its own announcement for that reason — two nested live regions
        would say the same thing twice and the inner one would override the politeness chosen here.
      */}
      <div role="status" aria-live="polite" className="min-h-6">
        {message === null ? null : (
          <Alert tone="error" announce="off">
            {message}
          </Alert>
        )}
      </div>

      <FormField
        id="login-identifier"
        label={labels.identifier}
        hint={labels.identifierHint}
        required
      >
        <Input
          {...fieldAria('login-identifier', { hint: labels.identifierHint, required: true })}
          name="identifier"
          type="text"
          autoComplete="username"
          /* An email or a phone number is never in Arabic script, so the field stays left-to-right. */
          dir="ltr"
          value={identifier}
          onChange={setIdentifier}
        />
      </FormField>

      <FormField id="login-password" label={labels.password} required>
        <Input
          {...fieldAria('login-password', { required: true })}
          name="password"
          type="password"
          autoComplete="current-password"
          dir="ltr"
          value={password}
          onChange={setPassword}
        />
      </FormField>

      <Button type="submit" size="lg" fullWidth pending={pending} pendingLabel={labels.submitting}>
        {labels.submit}
      </Button>
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
