'use client';

import { useState, type FormEvent } from 'react';

/**
 * The two thin clients of TOTP enrolment and the AAL2 challenge (Phase 7-B).
 *
 * Thin is the whole design, and here it carries a specific promise: **this code never learns which
 * factor or challenge it is answering.** Both live in an `HttpOnly` cookie the BFF writes and reads, so
 * the only values these components ever hold are what the person is typing and, for the length of the
 * setup screen, the secret they are enrolling.
 *
 * That secret is the one sensitive value React state holds anywhere in this project, and it is held as
 * briefly as it can be: it arrives from a `no-store` response, it is dropped the moment the code is
 * accepted, and it is never written to `localStorage`, `sessionStorage`, a URL or a form that could be
 * autofilled or restored. There is no Supabase client and no credential here either.
 *
 * The QR is rendered as an `<img>` with a `data:` URL rather than injected as markup. An SVG loaded
 * through `<img>` cannot execute script, which is what makes it safe to display a document the identity
 * provider produced; `img-src 'self' blob: data:` is already the established CSP, so nothing is relaxed
 * for it. When no QR comes back the secret is shown for manual entry, which every authenticator accepts.
 */

export interface TotpLabels {
  readonly setupIntro: string;
  readonly scanHeading: string;
  readonly scanHint: string;
  readonly qrAlt: string;
  readonly secretHeading: string;
  readonly secretHint: string;
  readonly codeLabel: string;
  readonly codeHint: string;
  readonly begin: string;
  readonly submitVerify: string;
  readonly submitting: string;
  readonly incomplete: string;
  /** The generic refusal: a wrong code, an expired challenge, a spent one, a factor that is not theirs. */
  readonly failed: string;
  readonly invalid: string;
  readonly alreadyEnrolled: string;
  readonly notEnrolled: string;
  readonly throttled: string;
  readonly unavailable: string;
  readonly done: string;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base text-neutral-900 focus:border-neutral-900 focus:outline-none';
const BUTTON_CLASS =
  'mt-6 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';

/**
 * The complete status-to-sentence map for both TOTP steps, exported so a test can pin it.
 *
 * 401 is one sentence, whether the code was wrong, the challenge expired, already spent, or raised for a
 * factor that is not the caller's — the API does not distinguish them and neither may this. 409 is the
 * only place two sentences are possible, and both report the caller's own account state.
 */
export function totpMessageFor(status: number, code: string | null, labels: TotpLabels): string {
  if (status === 400) return labels.invalid;
  if (status === 401) return labels.failed;
  if (status === 409) {
    if (code === 'TOTP_ALREADY_ENROLLED') return labels.alreadyEnrolled;
    if (code === 'TOTP_NOT_ENROLLED') return labels.notEnrolled;
    return labels.invalid;
  }
  if (status === 429) return labels.throttled;
  return labels.unavailable;
}

/** Reads the problem code out of a refusal, or null when the body is not one. */
async function problemCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

/** A live region that carries at most one sentence, and never a value the person typed. */
function Status({ message }: { readonly message: string | null }) {
  return (
    <p aria-live="polite" role="status" className="min-h-6 text-sm text-neutral-900">
      {message}
    </p>
  );
}

/** The secret, in groups of four, so it can be read aloud and typed without losing one's place. */
function grouped(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(' ');
}

/**
 * The six-digit code field, shared by both steps.
 *
 * `autoComplete="one-time-code"` so a platform authenticator can fill it; `inputMode="numeric"` for a
 * numeric keypad on a phone; and `dir="ltr"` because a six-digit code is read left to right even on an
 * Arabic page, where an unmarked numeric field would otherwise reverse.
 */
function CodeField({
  labels,
  value,
  onChange,
  id,
}: {
  readonly labels: TotpLabels;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly id: string;
}) {
  return (
    <div className="mt-4">
      <label htmlFor={id} className="block text-sm font-medium text-neutral-900">
        {labels.codeLabel}
      </label>
      <input
        id={id}
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        required
        aria-describedby={`${id}-hint`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        dir="ltr"
        className={FIELD_CLASS}
      />
      <p id={`${id}-hint`} className="mt-1 text-sm text-neutral-600">
        {labels.codeHint}
      </p>
    </div>
  );
}

interface Enrolment {
  readonly secret: string;
  readonly otpauthUri: string;
  readonly qrSvg: string | null;
}

export interface TotpSetupFormProps {
  readonly labels: TotpLabels;
  readonly enrolAction: string;
  readonly challengeAction: string;
  readonly verifyAction: string;
  /** Where to send the person once the authenticator is confirmed. */
  readonly doneHref: string;
}

/**
 * Setting up an authenticator: create the factor, show the secret, confirm with a code.
 *
 * The secret is fetched only when the person asks to begin, so a page that is merely open has no secret
 * in it. Confirming raises a challenge and answers it in one submission, which is what makes the code
 * they are reading right now the code that completes enrolment.
 */
export function TotpSetupForm({
  labels,
  enrolAction,
  challengeAction,
  verifyAction,
  doneHref,
}: TotpSetupFormProps) {
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function begin(): Promise<void> {
    if (pending) return;
    setMessage(null);
    setPending(true);
    try {
      const response = await fetch(enrolAction, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (response.status === 200) {
        const body = (await response.json()) as Partial<Enrolment>;
        if (typeof body.secret === 'string' && typeof body.otpauthUri === 'string') {
          setEnrolment({
            secret: body.secret,
            otpauthUri: body.otpauthUri,
            qrSvg: typeof body.qrSvg === 'string' ? body.qrSvg : null,
          });
          return;
        }
        setMessage(labels.unavailable);
        return;
      }
      setMessage(totpMessageFor(response.status, await problemCode(response), labels));
    } catch {
      setMessage(labels.unavailable);
    } finally {
      setPending(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    if (code.trim() === '') {
      setMessage(labels.incomplete);
      return;
    }

    setPending(true);
    try {
      // Raised and answered in one go, so the code on screen is the code that completes enrolment.
      const raised = await fetch(challengeAction, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (raised.status !== 200) {
        setMessage(totpMessageFor(raised.status, await problemCode(raised), labels));
        return;
      }

      const response = await fetch(verifyAction, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (response.status === 200) {
        // The secret has done its job and is dropped before anything else happens.
        setEnrolment(null);
        setCode('');
        setMessage(labels.done);
        // A full navigation: the answer carried the `Set-Cookie` pair for the new aal2 session, and the
        // next page must be rendered from it.
        globalThis.location.assign(doneHref);
        return;
      }
      setMessage(totpMessageFor(response.status, await problemCode(response), labels));
    } catch {
      setMessage(labels.unavailable);
    } finally {
      setPending(false);
    }
  }

  if (enrolment === null) {
    return (
      <div className="mt-8 max-w-md">
        <Status message={message} />
        <p className="mt-4 text-neutral-600">{labels.setupIntro}</p>
        <button type="button" onClick={begin} disabled={pending} className={BUTTON_CLASS}>
          {pending ? labels.submitting : labels.begin}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-8 max-w-md">
      <Status message={message} />

      {enrolment.qrSvg !== null && (
        <div className="mt-4">
          <h2 className="text-base font-medium text-neutral-900">{labels.scanHeading}</h2>
          <p className="mt-1 text-sm text-neutral-600">{labels.scanHint}</p>
          {/* An `<img>`, never injected markup: SVG loaded this way cannot execute script. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:image/svg+xml;base64,${globalThis.btoa(
              String.fromCharCode(...new TextEncoder().encode(enrolment.qrSvg)),
            )}`}
            alt={labels.qrAlt}
            width={192}
            height={192}
            className="mt-3 h-48 w-48 rounded-md border border-neutral-200 bg-white p-2"
          />
        </div>
      )}

      <div className="mt-6">
        <h2 className="text-base font-medium text-neutral-900">{labels.secretHeading}</h2>
        <p className="mt-1 text-sm text-neutral-600">{labels.secretHint}</p>
        {/* Left to right and monospaced in every locale: a Base32 secret is transcribed character by
            character, and an RTL run would reverse the order somebody is copying. */}
        <p dir="ltr" className="mt-3 break-all rounded-md bg-neutral-100 px-3 py-2 font-mono text-sm text-neutral-900">
          {grouped(enrolment.secret)}
        </p>
      </div>

      <CodeField labels={labels} value={code} onChange={setCode} id="totp-setup-code" />
      <button type="submit" disabled={pending} className={BUTTON_CLASS}>
        {pending ? labels.submitting : labels.submitVerify}
      </button>
    </form>
  );
}

export interface TotpChallengeFormProps {
  readonly labels: TotpLabels;
  readonly challengeAction: string;
  readonly verifyAction: string;
  /** Where to send the person once the challenge is satisfied. */
  readonly doneHref: string;
}

/**
 * Answering a challenge with an authenticator already set up.
 *
 * The challenge is raised on submission rather than on page load, so a page left open overnight does not
 * hold a stale one — and so the code being typed is answered by a challenge of the same moment. Nothing
 * here names a factor: the server chooses the caller's own.
 */
export function TotpChallengeForm({
  labels,
  challengeAction,
  verifyAction,
  doneHref,
}: TotpChallengeFormProps) {
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    if (code.trim() === '') {
      setMessage(labels.incomplete);
      return;
    }

    setPending(true);
    try {
      const raised = await fetch(challengeAction, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (raised.status !== 200) {
        setMessage(totpMessageFor(raised.status, await problemCode(raised), labels));
        return;
      }

      const response = await fetch(verifyAction, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (response.status === 200) {
        setCode('');
        setMessage(labels.done);
        globalThis.location.assign(doneHref);
        return;
      }
      setMessage(totpMessageFor(response.status, await problemCode(response), labels));
    } catch {
      setMessage(labels.unavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-8 max-w-md">
      <Status message={message} />
      <CodeField labels={labels} value={code} onChange={setCode} id="totp-challenge-code" />
      <button type="submit" disabled={pending} className={BUTTON_CLASS}>
        {pending ? labels.submitting : labels.submitVerify}
      </button>
    </form>
  );
}
