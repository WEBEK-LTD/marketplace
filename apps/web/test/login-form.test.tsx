import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import { LoginForm, loginMessageFor, type LoginFormLabels } from '../src/components/login-form';

const LABELS: LoginFormLabels = {
  identifier: en.Login.identifier,
  identifierHint: en.Login.identifierHint,
  password: en.Login.password,
  submit: en.Login.submit,
  submitting: en.Login.submitting,
  incomplete: en.Login.incomplete,
  failed: en.Login.failed,
  invalid: en.Login.invalid,
  throttled: en.Login.throttled,
  unavailable: en.Login.unavailable,
};

const form = () => renderToStaticMarkup(<LoginForm labels={LABELS} action="/api/auth/login" successHref="/" />);

describe('the login form', () => {
  it('posts to this origin’s BFF route and nothing else', () => {
    const html = form();
    // The action is the only endpoint named anywhere in the component.
    expect(html).not.toContain('/v1/auth/login');
    expect(html).not.toContain('supabase');
    expect(html).not.toContain('/auth/v1/token');
  });

  it('labels both fields and uses the right autofill and input types', () => {
    const html = form();
    expect(html).toContain('for="login-identifier"');
    expect(html).toContain('id="login-identifier"');
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('for="login-password"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');
    // The password is never pre-filled and never echoed into the markup.
    expect(html).toContain('value=""');
  });

  it('starts with no message and an assertive-free live region', () => {
    const html = form();
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain(LABELS.failed);
  });

  it('gives every refusal its approved sentence, and one sentence for every 401', () => {
    expect(loginMessageFor(400, LABELS)).toBe(LABELS.invalid);
    expect(loginMessageFor(401, LABELS)).toBe(LABELS.failed);
    expect(loginMessageFor(429, LABELS)).toBe(LABELS.throttled);
    expect(loginMessageFor(503, LABELS)).toBe(LABELS.unavailable);
    // Anything the contract does not define is told as an unavailable service, never as a hint.
    for (const status of [402, 403, 404, 418, 500, 502, 504]) {
      expect(loginMessageFor(status, LABELS)).toBe(LABELS.unavailable);
    }
  });

  it('never words a failure in a way that discloses the account or the reason', () => {
    const sentences = [LABELS.failed, LABELS.invalid, LABELS.throttled, LABELS.unavailable, LABELS.incomplete];
    for (const sentence of sentences.map((value) => value.toLowerCase())) {
      for (const forbidden of ['exist', 'unknown', 'not found', 'locked', 'lockout', 'wrong password', 'incorrect password', 'no account']) {
        expect(sentence).not.toContain(forbidden);
      }
    }
    // 401 is the approved generic wording.
    expect(LABELS.failed).toBe('Authentication failed.');
  });
});
