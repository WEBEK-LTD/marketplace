'use client';

import { useState, type FormEvent } from 'react';

/**
 * The phone contact change, as a thin client.
 *
 * Two steps in one component, and the browser holds **nothing** between them. The challenge the second
 * step answers lives in an `HttpOnly` cookie the BFF sets and reads; this component never sees it, never
 * sends it and could not read it if it tried. The only state here is which step to show and what the
 * person is currently typing. The code itself never comes near the browser: it goes to the number being
 * claimed.
 *
 * The component reads only the **status** of each answer to choose a sentence, so no internal reason,
 * provider message or account detail can reach the page.
 */

export interface PhoneChangeLabels {
  readonly newPhone: string;
  readonly newPhoneHint: string;
  readonly code: string;
  readonly codeHint: string;
  readonly submitStart: string;
  readonly submitVerify: string;
  readonly submitting: string;
  readonly incomplete: string;
  /** Shown once a code has been sent. Says nothing about the account. */
  readonly sent: string;
  readonly done: string;
  /** 401 — the code was refused, or the session is not usable. */
  readonly failed: string;
  readonly invalid: string;
  readonly throttled: string;
  readonly unavailable: string;
  readonly signedOut: string;
}

export interface PhoneChangeFormProps {
  readonly labels: PhoneChangeLabels;
  readonly startAction: string;
  readonly verifyAction: string;
}

const FIELD_CLASS =
  'mt-1 block w-full rounded-md border border-edge px-3 py-2 text-base text-ink-strong focus:border-edge-strong focus:outline-none';
const BUTTON_CLASS =
  'mt-6 rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';

/**
 * The complete status-to-sentence map, exported so a test can pin it.
 *
 * 401 is one sentence whether the code was wrong, the challenge belongs to someone else or the session
 * has lapsed — except that a request the browser could not even send with a session says so, because
 * that one is actionable by the person.
 */
export function phoneChangeMessageFor(status: number, labels: PhoneChangeLabels): string {
  if (status === 400) return labels.invalid;
  if (status === 401) return labels.failed;
  if (status === 429) return labels.throttled;
  return labels.unavailable;
}

export function PhoneChangeForm({ labels, startAction, verifyAction }: PhoneChangeFormProps) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  // Which step to show — not the challenge itself, which the browser is never told.
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onStart(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    if (phone.trim() === '') {
      setMessage(labels.incomplete);
      return;
    }

    setPending(true);
    try {
      const response = await fetch(startAction, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });

      if (response.status === 200) {
        // The answer is `{ status: 'ok' }` and carries nothing else; the challenge is in a cookie this
        // code cannot read. All this step learns is that a code is on its way.
        setAwaitingCode(true);
        setMessage(labels.sent);
        return;
      }
      setMessage(response.status === 401 ? labels.signedOut : phoneChangeMessageFor(response.status, labels));
    } catch {
      setMessage(labels.unavailable);
    } finally {
      setPending(false);
    }
  }

  async function onVerify(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || !awaitingCode) return;
    setMessage(null);
    if (code.trim() === '') {
      setMessage(labels.incomplete);
      return;
    }

    setPending(true);
    try {
      const response = await fetch(verifyAction, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        // The code and nothing else: the challenge travels as the cookie the browser sends on its own.
        body: JSON.stringify({ otp: code.trim() }),
      });

      if (response.status === 200) {
        // The change is done and the person stays signed in: a contact change is not a session event.
        setCode('');
        setAwaitingCode(false);
        setPhone('');
        setDone(true);
        setMessage(labels.done);
        return;
      }
      // A refused code ends this challenge — the BFF has cleared its cookie — so the flow returns to the
      // first step and the person asks for a new code.
      if (response.status === 401) setAwaitingCode(false);
      setMessage(phoneChangeMessageFor(response.status, labels));
    } catch {
      setMessage(labels.unavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-8 max-w-sm">
      <p aria-live="polite" role="status" className="min-h-6 text-sm text-ink-strong">
        {message}
      </p>

      {!awaitingCode ? (
        <form onSubmit={onStart} noValidate>
          <div className="mt-4">
            <label htmlFor="contact-phone" className="block text-sm font-medium text-ink-strong">
              {labels.newPhone}
            </label>
            <input
              id="contact-phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              aria-describedby="contact-phone-hint"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              className={FIELD_CLASS}
            />
            <p id="contact-phone-hint" className="mt-1 text-sm text-ink-muted">
              {labels.newPhoneHint}
            </p>
          </div>
          <button type="submit" disabled={pending || done} className={BUTTON_CLASS}>
            {pending ? labels.submitting : labels.submitStart}
          </button>
        </form>
      ) : (
        <form onSubmit={onVerify} noValidate>
          <div className="mt-4">
            <label htmlFor="contact-code" className="block text-sm font-medium text-ink-strong">
              {labels.code}
            </label>
            <input
              id="contact-code"
              name="otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              aria-describedby="contact-code-hint"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className={FIELD_CLASS}
            />
            <p id="contact-code-hint" className="mt-1 text-sm text-ink-muted">
              {labels.codeHint}
            </p>
          </div>
          <button type="submit" disabled={pending} className={BUTTON_CLASS}>
            {pending ? labels.submitting : labels.submitVerify}
          </button>
        </form>
      )}
    </div>
  );
}
