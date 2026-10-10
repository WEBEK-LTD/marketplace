'use client';

import { useState, type FormEvent } from 'react';

/**
 * The two thin clients of registration and contact verification (Phase 7-A).
 *
 * Thin is the whole design, and here it carries a specific promise. Each form posts to a BFF route on
 * this origin and reads **only the status** of the answer to choose a sentence. Nothing here holds a
 * challenge identifier, a code digest, a token or an account detail: the challenge lives in an `HttpOnly`
 * cookie this code cannot read, and the only values it keeps in React state are what the person is
 * currently typing.
 *
 * That is what makes the neutral response real rather than stated. The registration step answers the same
 * way whether or not the address already belongs to somebody, and because this component never receives
 * anything beyond the status, there is no field here it could branch on even by accident — and no
 * difference for someone reading the network tab to find.
 *
 * There is no Supabase client, no credential, no `localStorage`, no `sessionStorage`, and no challenge
 * identifier in any URL: unlike the recovery flow, which carries its opaque identifier in the query
 * string, registration keeps it server-side from the first step, so nothing about a registration in
 * progress reaches the browser's history, a referrer header or a shared link.
 */

export interface RegisterLabels {
  readonly email: string;
  readonly emailHint: string;
  readonly phone: string;
  readonly phoneHint: string;
  readonly password: string;
  readonly passwordHint: string;
  readonly displayName: string;
  readonly displayNameHint: string;
  readonly code: string;
  readonly codeHint: string;
  readonly submitRegister: string;
  readonly submitVerify: string;
  readonly submitResend: string;
  readonly submitting: string;
  readonly incomplete: string;
  /** The approved neutral answer to a registration, shown whatever the address was. */
  readonly started: string;
  /** A new code is on its way. */
  readonly resent: string;
  /** The generic failure for a refused code or a challenge that resolves nothing. */
  readonly failed: string;
  readonly invalid: string;
  readonly throttled: string;
  readonly unavailable: string;
  readonly done: string;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-edge px-3 py-2 text-base text-ink-strong focus:border-edge-strong focus:outline-none';
const BUTTON_CLASS =
  'mt-6 rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const SECONDARY_BUTTON_CLASS =
  'mt-3 rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong disabled:opacity-60';

/**
 * The complete status-to-sentence map for both registration steps, exported so a test can pin it.
 *
 * 401 is one sentence, whether the code was wrong, the challenge unknown, already spent, of another
 * purpose, or belonging to an account that has already confirmed a contact. Anything unexpected is told as
 * an unavailable service rather than as a detail about an account. There is deliberately no branch for a
 * 409 or any other "already registered" status, because the server never sends one.
 */
export function registerMessageFor(status: number, labels: RegisterLabels): string {
  if (status === 400) return labels.invalid;
  if (status === 401) return labels.failed;
  if (status === 429) return labels.throttled;
  return labels.unavailable;
}

/** A live region that carries at most one sentence, and never a value the person typed. */
function Status({ message }: { readonly message: string | null }) {
  return (
    <p aria-live="polite" role="status" className="min-h-6 text-sm text-ink-strong">
      {message}
    </p>
  );
}

export interface RegisterFormProps {
  readonly labels: RegisterLabels;
  readonly action: string;
  /** Where the flow continues once a code has been requested. */
  readonly nextHref: string;
}

/**
 * Step one: create the account and ask for a code.
 *
 * On success the person is told a code is on its way to the number they gave — the same sentence for every
 * address, because the server's answer is the same for every address. The password is cleared from state
 * before the navigation, so it does not sit in a component that is about to be torn down.
 */
export function RegisterForm({ labels, action, nextHref }: RegisterFormProps) {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    if (email.trim() === '' || phone.trim() === '' || password === '') {
      setMessage(labels.incomplete);
      return;
    }

    setPending(true);
    try {
      const response = await fetch(action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          phone: phone.trim(),
          password,
          // Omitted rather than sent empty: the field is optional, and the API's schema is strict about
          // what an empty string means.
          ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
        }),
      });

      if (response.status === 200) {
        setPassword('');
        setMessage(labels.started);
        // A full navigation, not a client-side push: the answer carried a `Set-Cookie` holding the
        // challenge, and the next page is rendered on the server from that cookie.
        globalThis.location.assign(nextHref);
        return;
      }
      setMessage(registerMessageFor(response.status, labels));
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
        <label htmlFor="register-email" className="block text-sm font-medium text-ink-strong">
          {labels.email}
        </label>
        <input
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-describedby="register-email-hint"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={FIELD_CLASS}
        />
        <p id="register-email-hint" className="mt-1 text-sm text-ink-muted">
          {labels.emailHint}
        </p>
      </div>
      <div className="mt-4">
        <label htmlFor="register-phone" className="block text-sm font-medium text-ink-strong">
          {labels.phone}
        </label>
        <input
          id="register-phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          spellCheck={false}
          required
          aria-describedby="register-phone-hint"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          // The number is typed and read left to right even in Arabic: an E.164 number with its leading
          // plus reverses visually under RTL, and a person checking their own number needs to see it the
          // way they dial it.
          dir="ltr"
          className={FIELD_CLASS}
        />
        <p id="register-phone-hint" className="mt-1 text-sm text-ink-muted">
          {labels.phoneHint}
        </p>
      </div>
      <div className="mt-4">
        <label htmlFor="register-password" className="block text-sm font-medium text-ink-strong">
          {labels.password}
        </label>
        <input
          id="register-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          aria-describedby="register-password-hint"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={FIELD_CLASS}
        />
        <p id="register-password-hint" className="mt-1 text-sm text-ink-muted">
          {labels.passwordHint}
        </p>
      </div>
      <div className="mt-4">
        <label htmlFor="register-name" className="block text-sm font-medium text-ink-strong">
          {labels.displayName}
        </label>
        <input
          id="register-name"
          name="displayName"
          type="text"
          autoComplete="name"
          aria-describedby="register-name-hint"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className={FIELD_CLASS}
        />
        <p id="register-name-hint" className="mt-1 text-sm text-ink-muted">
          {labels.displayNameHint}
        </p>
      </div>
      <button type="submit" disabled={pending} className={BUTTON_CLASS}>
        {pending ? labels.submitting : labels.submitRegister}
      </button>
    </form>
  );
}

export interface RegisterVerifyFormProps {
  readonly labels: RegisterLabels;
  readonly action: string;
  readonly resendAction: string;
  /** Where to send the person once the contact is confirmed. Sign-in, never a session. */
  readonly signInHref: string;
}

/**
 * Step two: submit the code, and ask for another if it never came.
 *
 * Neither button carries a challenge identifier or a destination. The challenge is the cookie the browser
 * sends automatically and this code cannot read; the number a resend reaches is decided in the database
 * from the account, so there is nothing here that could aim it.
 *
 * On success the person goes to the sign-in page. That is VERIFY FIRST made visible: no session exists at
 * any point in this flow, so there is nothing to be signed in with until they sign in.
 */
export function RegisterVerifyForm({
  labels,
  action,
  resendAction,
  signInHref,
}: RegisterVerifyFormProps) {
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || resending) return;
    setMessage(null);
    if (code.trim() === '') {
      setMessage(labels.incomplete);
      return;
    }

    setPending(true);
    try {
      const response = await fetch(action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ otp: code.trim() }),
      });

      if (response.status === 200) {
        setCode('');
        setMessage(labels.done);
        globalThis.location.assign(signInHref);
        return;
      }
      setMessage(registerMessageFor(response.status, labels));
    } catch {
      setMessage(labels.unavailable);
    } finally {
      setPending(false);
    }
  }

  async function onResend(): Promise<void> {
    if (pending || resending) return;
    setMessage(null);
    setResending(true);
    try {
      const response = await fetch(resendAction, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        // An empty object, not the challenge: the BFF supplies that from its own cookie.
        body: JSON.stringify({}),
      });

      // A 429 here is the approved cooldown, which is the common answer to pressing this twice. It is
      // told as "wait and try again", the same sentence every other throttle uses.
      setMessage(
        response.status === 200 ? labels.resent : registerMessageFor(response.status, labels),
      );
    } catch {
      setMessage(labels.unavailable);
    } finally {
      setResending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-8 max-w-sm">
      <Status message={message} />
      <div className="mt-4">
        <label htmlFor="register-code" className="block text-sm font-medium text-ink-strong">
          {labels.code}
        </label>
        <input
          id="register-code"
          name="otp"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          aria-describedby="register-code-hint"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          dir="ltr"
          className={FIELD_CLASS}
        />
        <p id="register-code-hint" className="mt-1 text-sm text-ink-muted">
          {labels.codeHint}
        </p>
      </div>
      <div className="flex flex-col items-start">
        <button type="submit" disabled={pending || resending} className={BUTTON_CLASS}>
          {pending ? labels.submitting : labels.submitVerify}
        </button>
        <button
          type="button"
          onClick={onResend}
          disabled={pending || resending}
          className={SECONDARY_BUTTON_CLASS}
        >
          {resending ? labels.submitting : labels.submitResend}
        </button>
      </div>
    </form>
  );
}
