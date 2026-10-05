'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/**
 * The three thin clients of the F3 recovery flow.
 *
 * Thin is the whole design. Each form posts to a BFF route on this origin and reads **only the status**
 * of the answer to choose a sentence. Nothing here holds a reset token, a code digest or an account
 * detail: the token lives in an `HttpOnly` cookie the browser cannot read, and the only value this code
 * ever keeps in React state is what the person is currently typing.
 *
 * There is no Supabase client, no credential, no `localStorage`, no `sessionStorage` and no token in any
 * URL — the BFF navigates the browser to a path it returns, never to a link carrying a token.
 */

export interface RecoveryLabels {
  readonly identifier: string;
  readonly identifierHint: string;
  readonly code: string;
  readonly codeHint: string;
  readonly newPassword: string;
  readonly newPasswordHint: string;
  readonly submitStart: string;
  readonly submitVerify: string;
  readonly submitReset: string;
  readonly submitting: string;
  readonly incomplete: string;
  /** The approved neutral answer to a reset request, shown whatever the identifier was. */
  readonly started: string;
  /** The generic failure for a refused code or a refused token. */
  readonly failed: string;
  readonly invalid: string;
  readonly throttled: string;
  readonly unavailable: string;
  readonly done: string;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base text-neutral-900 focus:border-neutral-900 focus:outline-none';
const BUTTON_CLASS =
  'mt-6 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';

/**
 * The complete status-to-sentence map for every recovery step, exported so a test can pin it.
 *
 * 401 is one sentence, whether the code was wrong, the challenge unknown, the token expired or the token
 * already spent. Anything unexpected is told as an unavailable service rather than as a detail about an
 * account.
 */
export function recoveryMessageFor(status: number, labels: RecoveryLabels): string {
  if (status === 400) return labels.invalid;
  if (status === 401) return labels.failed;
  if (status === 429) return labels.throttled;
  return labels.unavailable;
}

/** A live region that carries at most one sentence, and never a value the person typed. */
function Status({ message }: { readonly message: string | null }) {
  return (
    <p aria-live="polite" role="status" className="min-h-6 text-sm text-neutral-900">
      {message}
    </p>
  );
}

export interface StartFormProps {
  readonly labels: RecoveryLabels;
  readonly action: string;
  /** Where the flow continues once a code has been requested. */
  readonly nextHref: string;
}

/**
 * Step one: ask for a code.
 *
 * On success the person is told a code has been sent *if the account exists* — the same sentence for
 * every identifier, because the server's answer is the same for every identifier.
 */
export function RecoveryStartForm({ labels, action, nextHref }: StartFormProps) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    if (identifier.trim() === '') {
      setMessage(labels.incomplete);
      return;
    }

    setPending(true);
    try {
      const response = await fetch(action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim() }),
      });

      if (response.status === 200) {
        // The challenge id is the one thing the next step needs, and it is carried in the URL rather
        // than kept in storage: it is an opaque identifier, not a credential, and it is useless without
        // the code that was sent to the account's contact.
        const body = (await response.json()) as { challengeId?: unknown };
        const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
        setMessage(labels.started);
        // A client-side navigation is right here and only here: nothing about the session changed, so
        // there is no cookie for a fresh document load to pick up. The two later steps navigate fully,
        // because each of them follows a `Set-Cookie` the next request must carry.
        router.push(`${nextHref}?challenge=${encodeURIComponent(challengeId)}`);
        return;
      }
      setMessage(recoveryMessageFor(response.status, labels));
    } catch {
      setMessage(labels.unavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-8 max-w-sm">
      <Status message={message} />
      <div className="mt-4">
        <label htmlFor="recovery-identifier" className="block text-sm font-medium text-neutral-900">
          {labels.identifier}
        </label>
        <input
          id="recovery-identifier"
          name="identifier"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-describedby="recovery-identifier-hint"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          className={FIELD_CLASS}
        />
        <p id="recovery-identifier-hint" className="mt-1 text-sm text-neutral-600">
          {labels.identifierHint}
        </p>
      </div>
      <button type="submit" disabled={pending} className={BUTTON_CLASS}>
        {pending ? labels.submitting : labels.submitStart}
      </button>
    </form>
  );
}

export interface VerifyFormProps {
  readonly labels: RecoveryLabels;
  readonly action: string;
  /** The opaque challenge identifier the previous step returned. */
  readonly challengeId: string;
  /** Where to go if the server does not say. */
  readonly fallbackHref: string;
}

/**
 * Step two: submit the code.
 *
 * A success sets the reset cookie on the server side; this component never sees a token. It follows the
 * path the BFF returns, which carries no token and no code.
 */
export function RecoveryVerifyForm({ labels, action, challengeId, fallbackHref }: VerifyFormProps) {
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    if (code.trim() === '' || challengeId === '') {
      setMessage(labels.incomplete);
      return;
    }

    setPending(true);
    try {
      const response = await fetch(action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId, otp: code.trim() }),
      });

      if (response.status === 200) {
        const body = (await response.json()) as { next?: unknown };
        const next = typeof body.next === 'string' ? body.next : fallbackHref;
        setCode('');
        globalThis.location.assign(next);
        return;
      }
      setMessage(recoveryMessageFor(response.status, labels));
    } catch {
      setMessage(labels.unavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-8 max-w-sm">
      <Status message={message} />
      <div className="mt-4">
        <label htmlFor="recovery-code" className="block text-sm font-medium text-neutral-900">
          {labels.code}
        </label>
        <input
          id="recovery-code"
          name="otp"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          aria-describedby="recovery-code-hint"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className={FIELD_CLASS}
        />
        <p id="recovery-code-hint" className="mt-1 text-sm text-neutral-600">
          {labels.codeHint}
        </p>
      </div>
      <button type="submit" disabled={pending} className={BUTTON_CLASS}>
        {pending ? labels.submitting : labels.submitVerify}
      </button>
    </form>
  );
}

export interface ResetFormProps {
  readonly labels: RecoveryLabels;
  readonly action: string;
  /** Where to send the person once the password has been changed. Sign-in, never a session. */
  readonly signInHref: string;
}

/**
 * Step three: choose a new password.
 *
 * The form sends only the password. The token that authorises the change is the `HttpOnly` cookie the
 * browser sends automatically and this code cannot read.
 */
export function RecoveryResetForm({ labels, action, signInHref }: ResetFormProps) {
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    if (password === '') {
      setMessage(labels.incomplete);
      return;
    }

    setPending(true);
    try {
      const response = await fetch(action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newPassword: password }),
      });

      if (response.status === 200) {
        // Recovery never signs anyone in: the person is sent to the sign-in page with their new
        // password, and no session exists at any point in this flow.
        setPassword('');
        setMessage(labels.done);
        globalThis.location.assign(signInHref);
        return;
      }
      setMessage(recoveryMessageFor(response.status, labels));
    } catch {
      setMessage(labels.unavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-8 max-w-sm">
      <Status message={message} />
      <div className="mt-4">
        <label htmlFor="recovery-password" className="block text-sm font-medium text-neutral-900">
          {labels.newPassword}
        </label>
        <input
          id="recovery-password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          aria-describedby="recovery-password-hint"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={FIELD_CLASS}
        />
        <p id="recovery-password-hint" className="mt-1 text-sm text-neutral-600">
          {labels.newPasswordHint}
        </p>
      </div>
      <button type="submit" disabled={pending} className={BUTTON_CLASS}>
        {pending ? labels.submitting : labels.submitReset}
      </button>
    </form>
  );
}
