import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import {
  PhoneChangeForm,
  phoneChangeMessageFor,
  type PhoneChangeLabels,
} from '../src/components/phone-change-form';

const LABELS: PhoneChangeLabels = {
  newPhone: en.Security.newPhone,
  newPhoneHint: en.Security.newPhoneHint,
  code: en.Security.code,
  codeHint: en.Security.codeHint,
  submitStart: en.Security.submitStart,
  submitVerify: en.Security.submitVerify,
  submitting: en.Security.submitting,
  incomplete: en.Security.incomplete,
  sent: en.Security.sent,
  done: en.Security.done,
  failed: en.Security.failed,
  invalid: en.Security.invalid,
  throttled: en.Security.throttled,
  unavailable: en.Security.unavailable,
  signedOut: en.Security.signedOut,
};

const form = () =>
  renderToStaticMarkup(
    <PhoneChangeForm
      labels={LABELS}
      startAction="/api/auth/contact/phone/start"
      verifyAction="/api/auth/contact/phone/verify"
    />,
  );

describe('the phone change form', () => {
  it('posts to this origin’s BFF routes and nothing else', () => {
    const html = form();
    expect(html).not.toContain('/v1/users/me/contact');
    expect(html).not.toContain('supabase');
    expect(html).not.toContain('/auth/v1/');
  });

  it('starts on the number step, with the field empty and labelled', () => {
    const html = form();
    expect(html).toContain('for="contact-phone"');
    expect(html).toContain('type="tel"');
    expect(html).toContain('autoComplete="tel"');
    expect(html).toContain('value=""');
    // The code step appears only once a code has been sent.
    expect(html).not.toContain('id="contact-code"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
  });

  it('holds no challenge: the browser is never told which one it is answering', () => {
    const source = readFileSync(new URL('../src/components/phone-change-form.tsx', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // No challenge identifier, no cookie reading, no storage — the cookie is the BFF's alone.
    expect(code).not.toContain('challengeId');
    expect(code).not.toContain('__Host-');
    expect(code).not.toContain('document.cookie');
    expect(code).not.toContain('localStorage');
    expect(code).not.toContain('sessionStorage');
    expect(code).not.toContain('indexedDB');
    // The verify request carries exactly one field.
    expect(code).toContain("JSON.stringify({ otp: code.trim() })");
  });

  it('gives every refusal its approved sentence, and one sentence for every 401', () => {
    expect(phoneChangeMessageFor(400, LABELS)).toBe(LABELS.invalid);
    expect(phoneChangeMessageFor(401, LABELS)).toBe(LABELS.failed);
    expect(phoneChangeMessageFor(429, LABELS)).toBe(LABELS.throttled);
    expect(phoneChangeMessageFor(503, LABELS)).toBe(LABELS.unavailable);
    for (const status of [402, 403, 404, 500, 502, 504]) {
      expect(phoneChangeMessageFor(status, LABELS)).toBe(LABELS.unavailable);
    }
  });

  it('never words an outcome in a way that discloses an account or a reason', () => {
    for (const sentence of Object.values(LABELS).map((value) => value.toLowerCase())) {
      for (const forbidden of ['already in use', 'exists', 'unknown', 'not found', 'belongs to', 'provider']) {
        expect(sentence).not.toContain(forbidden);
      }
    }
  });
});
