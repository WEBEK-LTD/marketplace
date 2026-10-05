import { Logger } from '@nestjs/common';
import {
  AuthProviderUnavailableError,
  AuthenticationRequiredError,
  InvalidCredentialsError,
} from './auth-errors.js';

/**
 * What a successful password grant returns.
 *
 * The tokens never reach a browser as a body: the BFF turns them into the `__Host-` cookies of C-8 and
 * the browser sees only `Set-Cookie`. They are typed here because the server has to carry them across
 * exactly one hop, from this client to the BFF.
 */
export interface SupabaseSession {
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Seconds until the access token expires, as the provider reports it. */
  readonly expiresIn: number;
}

/** The part of a provider user this project reads: who they are and the contact it holds. */
export interface SupabaseUser {
  readonly id: string;
  readonly phone: string | null;
}

/** One of the caller's TOTP factors, reduced to what any decision in this project needs (Phase 7-B). */
export interface TotpFactor {
  readonly id: string;
  readonly verified: boolean;
}

/**
 * What a fresh TOTP enrolment hands back, and the only shape in this project that carries a secret.
 *
 * `qrSvg` is the provider's own QR document when it supplied one, and null otherwise — the setup screen
 * works either way, because manual entry of the secret is universally supported.
 */
export interface TotpEnrolment {
  readonly factorId: string;
  readonly secret: string;
  readonly qrSvg: string | null;
}

export interface SupabaseAuthConfig {
  readonly url: string;
  readonly secretKey: string;
  readonly fetch?: typeof fetch;
  /** Milliseconds before a provider call is abandoned. A hung provider must not hang a login. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Server-side Supabase Auth password sign-in.
 *
 * This is the only place the project's Supabase credentials are used, and it lives behind the API
 * boundary on purpose: under the approved architecture the browser never speaks to Supabase Auth, so
 * there is no client library here, no session persistence and no token refresh loop — just one call.
 *
 * Failure classification is the security-critical part. Supabase answers a wrong password and an
 * identifier that was never registered with the *same* `invalid_grant`, and this client keeps them the
 * same: one {@link InvalidCredentialsError}, carrying nothing that could tell them apart. Anything that
 * is not a clean credential refusal — a timeout, a 5xx, a body that does not parse — becomes
 * {@link AuthProviderUnavailableError} instead, because an outage reported as "wrong password" is both
 * a lie to the user and an invisible incident.
 */
export class SupabaseAuthClient {
  private readonly logger = new Logger(SupabaseAuthClient.name);
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: SupabaseAuthConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Exchanges an identifier and password for a session.
   *
   * @throws InvalidCredentialsError when the provider refuses the credentials, for any reason it would
   *   refuse them — the caller must not be able to learn which.
   * @throws AuthProviderUnavailableError when the provider could not be reached or did not answer in a
   *   way this client understands.
   */
  async signInWithPassword(identifier: string, password: string): Promise<SupabaseSession> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          apikey: this.config.secretKey,
          authorization: `Bearer ${this.config.secretKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...identifierField(identifier), password }),
        signal: controller.signal,
      });
    } catch (error) {
      // The message is ours, not the provider's: an error string from fetch can contain the URL.
      this.logger.error('Supabase Auth could not be reached.');
      throw new AuthProviderUnavailableError(error);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // Read and discard: the provider's description distinguishes "invalid credentials" from "email
      // not confirmed", and neither this service nor its caller is allowed to act on that difference.
      await response.text().catch(() => '');
      throw new InvalidCredentialsError();
    }

    if (!response.ok) {
      this.logger.error(`Supabase Auth answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new AuthProviderUnavailableError(error);
    }

    const session = readSession(body);
    if (session === null) {
      this.logger.error('Supabase Auth returned a session this client does not understand.');
      throw new AuthProviderUnavailableError(new Error('unexpected provider payload'));
    }
    return session;
  }

  /**
   * Exchanges a refresh token for a new session (Phase 5-A).
   *
   * This is the renewal half of C-8 and it creates nothing: the account, the device record and the
   * lockout state are whatever login established. The refresh token is presented as the caller's own,
   * in the body, with the service key only as the project `apikey` — the same shape as the password
   * grant, and for the same reason: the provider must answer for this session, not for the service.
   *
   * **Every refusal is one refusal.** An expired token, a revoked one, a malformed one and one that has
   * already been spent all leave as {@link InvalidCredentialsError}, carrying nothing that could tell
   * them apart. A caller that could distinguish "expired" from "already used" could probe which of two
   * stolen tokens is the live one.
   *
   * The new refresh token that comes back replaces the old one; whether the provider retires the old
   * token immediately is the provider's behaviour and is not assumed here. What this project guarantees
   * is its own half: the BFF writes both new values into the cookies, so the browser stops presenting
   * the old refresh token from this moment on.
   *
   * @throws InvalidCredentialsError when the provider refuses the token, for any reason it would.
   * @throws AuthProviderUnavailableError when the provider could not be reached or was not understood.
   */
  async refreshSession(refreshToken: string): Promise<SupabaseSession> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          apikey: this.config.secretKey,
          authorization: `Bearer ${this.config.secretKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.error('Supabase Auth could not be reached.');
      throw new AuthProviderUnavailableError(error);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // Read and discard, exactly as the password grant does: the provider's description separates an
      // expired token from a revoked one, and nothing downstream is allowed to act on the difference.
      await response.text().catch(() => '');
      throw new InvalidCredentialsError();
    }

    if (!response.ok) {
      this.logger.error(`Supabase Auth answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new AuthProviderUnavailableError(error);
    }

    const session = readSession(body);
    if (session === null) {
      this.logger.error('Supabase Auth returned a session this client does not understand.');
      throw new AuthProviderUnavailableError(new Error('unexpected provider payload'));
    }
    return session;
  }

  /**
   * Ends the caller's **own** session and no other (Phase 5-A).
   *
   * The distinction from {@link revokeAllSessions} is the whole point of this method existing. That one
   * is the administrative hammer the password reset needs — every session of the account, gone. This
   * one is what a person means by "sign out": the session in front of them. It therefore goes to the
   * user-facing logout route with the caller's own access token and the local scope, never to the admin
   * API, so signing out on a laptop cannot sign the same person out on their phone.
   *
   * The outcome is reported rather than thrown, because a token the provider no longer recognises is a
   * *successful* sign-out from the browser's point of view: the session it names is already gone. Only
   * an unreachable provider is an error, and even then the BFF still clears the cookies — the browser's
   * session ends whatever the provider says, and this call is what tidies up the provider's side.
   */
  async signOut(accessToken: string): Promise<'signed_out' | 'already_invalid'> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: {
          apikey: this.config.secretKey,
          // The caller's own token: this ends the session that presented it.
          authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.error('Supabase Auth could not be reached.');
      throw new AuthProviderUnavailableError(error);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      await response.text().catch(() => '');
      return 'already_invalid';
    }
    if (!response.ok) {
      this.logger.error(`Supabase Auth answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }
    await response.text().catch(() => '');
    return 'signed_out';
  }

  /**
   * Sets an account's password through the Supabase Auth **Admin** API (F3, owner decision 10).
   *
   * The service credential is used here and nowhere near a browser: the reset flow never signs the
   * person in, so there is no user token to act with, and the admin route is the approved mechanism for
   * changing a password the person could not otherwise prove they own.
   *
   * The password is in the request body and nowhere else — not in the URL, not in a log line, not in an
   * error. Any non-2xx becomes {@link AuthProviderUnavailableError}: there is no failure of this call
   * that the caller should translate into "the reset succeeded".
   */
  async updatePassword(userId: string, password: string): Promise<void> {
    const response = await this.adminCall(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      body: JSON.stringify({ password }),
    });

    if (!response.ok) {
      this.logger.error(`Supabase Auth admin password update answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }
    // The response body describes the user. Nothing here needs it, so it is read and dropped rather
    // than parsed into something a caller could accidentally return.
    await response.text().catch(() => '');
  }

  /**
   * Revokes every session the account has (F3, owner decision 11).
   *
   * What this does and does not achieve is worth stating exactly, because the difference is a security
   * property and not a detail: revoking sessions invalidates the refresh tokens, so no session can be
   * renewed and every client is signed out at its next refresh. An access token that was already issued
   * stays cryptographically valid until it expires — at most the 15 minutes of C-8 — because it is a
   * signed JWT and nothing can recall it. The approved flow accepts that window; it is why the reset
   * revokes sessions rather than pretending to invalidate tokens.
   *
   * A failure is never swallowed. A password changed without the old sessions being cut is exactly the
   * state an attacker who still holds a session wants, so the caller treats this throwing as a failed
   * reset and leaves the token unconsumed for a retry.
   */
  async revokeAllSessions(userId: string): Promise<void> {
    const response = await this.adminCall(`/auth/v1/admin/users/${encodeURIComponent(userId)}/sessions`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      this.logger.error(`Supabase Auth admin session revocation answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }
    await response.text().catch(() => '');
  }

  /**
   * Resolves the caller's own account from their access token (F4).
   *
   * `GET /auth/v1/user` is the provider's own answer to "whose token is this", so the account is never
   * taken from the request: a browser cannot name a user, and a token that has expired or been revoked
   * simply fails here. The token belongs to the caller and is presented as theirs, not as the service.
   *
   * @throws AuthenticationRequiredError when the provider refuses the token.
   * @throws AuthProviderUnavailableError when it could not be asked.
   */
  async getUser(accessToken: string): Promise<SupabaseUser> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url}/auth/v1/user`, {
        method: 'GET',
        headers: {
          apikey: this.config.secretKey,
          // The caller's own token, not the service credential: this call must answer for them.
          authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.error('Supabase Auth could not be reached.');
      throw new AuthProviderUnavailableError(error);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      await response.text().catch(() => '');
      throw new AuthenticationRequiredError();
    }
    if (!response.ok) {
      this.logger.error(`Supabase Auth answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new AuthProviderUnavailableError(error);
    }
    const user = readUser(body);
    if (user === null) {
      this.logger.error('Supabase Auth returned a user this client does not understand.');
      throw new AuthProviderUnavailableError(new Error('unexpected provider payload'));
    }
    return user;
  }

  /**
   * Sets an account's phone through the Supabase Auth **Admin** API (F4, approved decision 1).
   *
   * `phone_confirm` is sent because the number has already been proven: the marketplace sent a code to
   * it and the person returned that code. The provider is told the outcome of our verification, not
   * asked to run one of its own — which is what keeps the provider's own confirmation messages, blocked
   * by the guard hooks, out of this flow entirely.
   */
  async updatePhone(userId: string, phone: string): Promise<void> {
    const response = await this.adminCall(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      body: JSON.stringify({ phone, phone_confirm: true }),
    });

    if (!response.ok) {
      this.logger.error(`Supabase Auth admin phone update answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }
    await response.text().catch(() => '');
  }

  /**
   * Creates an account with **no confirmed contact** (Phase 7-A).
   *
   * `email_confirm` and `phone_confirm` are both sent as `false`, deliberately and explicitly: the
   * approved decision is that a new account verifies its contact before it can sign in, and an account
   * created as already-confirmed would be signed-in-able the moment it exists. The marketplace confirms
   * the phone itself, later, through {@link confirmPhone}, once it has seen the code come back — the same
   * shape {@link updatePhone} already uses, where the provider is told the outcome of our verification
   * rather than asked to run one of its own.
   *
   * The optional display name travels as `user_metadata.display_name`, which is not a choice made here:
   * migration 0005's `on_auth_user_created` trigger already reads exactly that key when it creates the
   * person's `public.profiles` row, and the profile's own 1–80 character rule is the one the contract
   * enforces on the way in. So 7-A writes no profile of its own and touches no table — it supplies the
   * value the mechanism that has existed since 0005 already looks for. (The same trigger keeps
   * `profiles.phone_verified_at` in step on update, which is how {@link confirmPhone} reaches the profile
   * without this increment writing there either.)
   *
   * @returns the new account's id, or `null` when the provider refused because the address is already
   *          taken. `null` is an answer, not a failure: the caller turns both into the same response, so
   *          registration cannot be used to discover who has an account.
   */
  async createUnconfirmedUser(input: {
    email: string;
    phone: string;
    password: string;
    displayName?: string | undefined;
  }): Promise<string | null> {
    const response = await this.adminCall('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        phone: input.phone,
        password: input.password,
        email_confirm: false,
        phone_confirm: false,
        // Omitted entirely when absent, rather than sent empty: the trigger's `nullif(btrim(...))` would
        // cope, but an absent optional field should not become a present empty one on the way through.
        ...(input.displayName === undefined || input.displayName === ''
          ? {}
          : { user_metadata: { display_name: input.displayName } }),
      }),
    });

    if (response.status === 422 || response.status === 409 || response.status === 400) {
      // The provider's "already registered" family. Read and discarded: the body may name the address,
      // and nothing above this line is allowed to learn which field collided.
      await response.text().catch(() => '');
      return null;
    }
    if (!response.ok) {
      this.logger.error(`Supabase Auth admin user creation answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }

    const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
    const id = body?.id;
    if (typeof id !== 'string' || id === '') {
      this.logger.error('Supabase Auth admin user creation answered without an account id.');
      throw new AuthProviderUnavailableError(new Error('provider returned no account id'));
    }
    return id;
  }

  /**
   * Confirms an account's phone after the marketplace has verified it (Phase 7-A).
   *
   * The number is not sent, only the confirmation: the account already has it, it was proven by the code
   * that came back, and sending it again would be a second chance to get it wrong. Otherwise identical to
   * {@link updatePhone}, which does the same thing for a number that is changing.
   */
  async confirmPhone(userId: string): Promise<void> {
    const response = await this.adminCall(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      body: JSON.stringify({ phone_confirm: true }),
    });

    if (!response.ok) {
      this.logger.error(`Supabase Auth admin phone confirmation answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }
    await response.text().catch(() => '');
  }

  /**
   * The caller's TOTP factors, as the provider reports them (Phase 7-B).
   *
   * Read from `GET /auth/v1/user` with the caller's own token, because that is where GoTrue returns a
   * user's factors and because a factor list must answer for the person asking, never for anybody else.
   * Only `totp` factors are returned and only two fields of each: what it is and whether it is verified.
   * A factor's `friendly_name` and every other field are dropped here rather than carried and filtered
   * later — a value that never enters the process cannot leave it.
   */
  async listTotpFactors(accessToken: string): Promise<readonly TotpFactor[]> {
    const response = await this.userCall('/auth/v1/user', accessToken, { method: 'GET' });

    if (response.status === 401 || response.status === 403) {
      await response.text().catch(() => '');
      throw new AuthenticationRequiredError();
    }
    if (!response.ok) {
      this.logger.error(`Supabase Auth answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new AuthProviderUnavailableError(error);
    }
    return readTotpFactors(body);
  }

  /**
   * Creates an unverified TOTP factor and returns the enrolment material (Phase 7-B).
   *
   * **This is the one call in the whole project that returns a shared secret.** It exists because a person
   * cannot enrol an authenticator without seeing the secret once, and the value is handled accordingly:
   * it is never logged, never written to our database, never put in a URL and never returned to a browser
   * except in the single `no-store` response that shows the setup screen. Nothing here persists it — the
   * provider holds it, which is the approved model ("Supabase Auth stores credentials, sessions and TOTP
   * factors behind a NestJS Auth façade").
   *
   * The provider's own QR image is passed through only when it is a string that really is an SVG
   * document; anything else yields null and the setup screen falls back to the secret, which every
   * authenticator accepts by manual entry. The caller renders it as an `<img>` data URL, where SVG cannot
   * execute script — the reason it is never injected as markup.
   */
  async enrolTotpFactor(
    accessToken: string,
    input: { friendlyName: string; issuer: string },
  ): Promise<TotpEnrolment> {
    const response = await this.userCall('/auth/v1/factors', accessToken, {
      method: 'POST',
      body: JSON.stringify({
        factor_type: 'totp',
        friendly_name: input.friendlyName,
        issuer: input.issuer,
      }),
    });

    if (response.status === 401 || response.status === 403) {
      await response.text().catch(() => '');
      throw new AuthenticationRequiredError();
    }
    if (!response.ok) {
      // The body may quote the friendly name or the issuer; it is read and discarded rather than logged.
      await response.text().catch(() => '');
      this.logger.error(`Supabase Auth TOTP enrolment answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new AuthProviderUnavailableError(error);
    }
    const enrolment = readTotpEnrolment(body);
    if (enrolment === null) {
      // Deliberately without the payload: it contains the secret.
      this.logger.error('Supabase Auth returned a TOTP enrolment this client does not understand.');
      throw new AuthProviderUnavailableError(new Error('unexpected provider payload'));
    }
    return enrolment;
  }

  /**
   * Raises a TOTP challenge against one of the caller's factors (Phase 7-B).
   *
   * Returns only the challenge identifier. That identifier is server state: it travels back to the BFF,
   * which holds it in an `HttpOnly` cookie, so a browser never chooses which challenge it is answering.
   */
  async challengeTotpFactor(accessToken: string, factorId: string): Promise<string> {
    const response = await this.userCall(
      `/auth/v1/factors/${encodeURIComponent(factorId)}/challenge`,
      accessToken,
      { method: 'POST', body: JSON.stringify({}) },
    );

    if (response.status === 401 || response.status === 403) {
      await response.text().catch(() => '');
      throw new AuthenticationRequiredError();
    }
    if (!response.ok) {
      await response.text().catch(() => '');
      this.logger.error(`Supabase Auth TOTP challenge answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new AuthProviderUnavailableError(error);
    }
    const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['id'] : undefined;
    if (typeof id !== 'string' || id === '') {
      this.logger.error('Supabase Auth returned a TOTP challenge this client does not understand.');
      throw new AuthProviderUnavailableError(new Error('unexpected provider payload'));
    }
    return id;
  }

  /**
   * Submits a TOTP code and returns the session the provider mints for it (Phase 7-B).
   *
   * **The provider decides, and this is the one place in the project where that is right.** Everywhere
   * else — the login OTP, the recovery code, the registration code — this project generates, hashes and
   * verifies the code itself, and the provider only carries a message. A TOTP factor is different in kind:
   * the secret lives with the provider by the approved model, so the provider is the only party that can
   * check a code against it, and the session it returns is the only thing that can carry `aal2` in a token
   * `public.is_aal2()` will believe. Verifying it ourselves would mean holding the secret ourselves.
   *
   * A wrong code is {@link InvalidCredentialsError} — the same generic refusal a wrong password earns —
   * so a caller cannot tell a wrong code from an expired challenge from a factor that is not theirs.
   */
  async verifyTotpFactor(
    accessToken: string,
    input: { factorId: string; challengeId: string; code: string },
  ): Promise<SupabaseSession> {
    const response = await this.userCall(
      `/auth/v1/factors/${encodeURIComponent(input.factorId)}/verify`,
      accessToken,
      {
        method: 'POST',
        // The code is in the body and nowhere else: not in the path, not in a query string, not in a log.
        body: JSON.stringify({ challenge_id: input.challengeId, code: input.code }),
      },
    );

    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422) {
      // The provider distinguishes a wrong code from an expired challenge from a factor that is not the
      // caller's. Nothing above this line does: the body is read and discarded and all of them leave as
      // one refusal, which is what keeps this surface from answering questions about somebody's factors.
      await response.text().catch(() => '');
      throw new InvalidCredentialsError();
    }
    if (!response.ok) {
      this.logger.error(`Supabase Auth TOTP verification answered ${response.status}.`);
      throw new AuthProviderUnavailableError(new Error(`provider status ${response.status}`));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new AuthProviderUnavailableError(error);
    }
    const session = readSession(body);
    if (session === null) {
      this.logger.error('Supabase Auth returned a session this client does not understand.');
      throw new AuthProviderUnavailableError(new Error('unexpected provider payload'));
    }
    return session;
  }

  /** One request made **as the caller**, with their token, the shared timeout and no URL in any error. */
  private async userCall(
    path: string,
    accessToken: string,
    init: { method: string; body?: string },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.config.url}${path}`, {
        method: init.method,
        headers: {
          apikey: this.config.secretKey,
          // The caller's own token, never the service credential: an MFA call must answer for the person
          // making it, and the service credential would make every one of them answer for everybody.
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.error('Supabase Auth could not be reached.');
      throw new AuthProviderUnavailableError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One admin request, with the service credential, the shared timeout and no URL in any error. */
  private async adminCall(path: string, init: { method: string; body?: string }): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.config.url}${path}`, {
        method: init.method,
        headers: {
          apikey: this.config.secretKey,
          authorization: `Bearer ${this.config.secretKey}`,
          'content-type': 'application/json',
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.error('Supabase Auth admin API could not be reached.');
      throw new AuthProviderUnavailableError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Chooses the provider's field for the identifier.
 *
 * An `@` means an email address; anything else is treated as a phone number. The value is passed through
 * unchanged — normalising a phone number to E.164 needs a country, which a login request does not carry,
 * and guessing one would make the same person fail to sign in depending on how they typed it.
 */
function identifierField(identifier: string): { email: string } | { phone: string } {
  return identifier.includes('@') ? { email: identifier } : { phone: identifier };
}

/** Reads the fields this service needs, or null if any of them is missing or the wrong type. */
function readSession(body: unknown): SupabaseSession | null {
  if (typeof body !== 'object' || body === null) return null;
  const payload = body as Record<string, unknown>;
  const user = payload['user'];
  const userId = typeof user === 'object' && user !== null ? (user as Record<string, unknown>)['id'] : undefined;
  const accessToken = payload['access_token'];
  const refreshToken = payload['refresh_token'];
  const expiresIn = payload['expires_in'];

  if (
    typeof userId !== 'string' ||
    userId === '' ||
    typeof accessToken !== 'string' ||
    accessToken === '' ||
    typeof refreshToken !== 'string' ||
    refreshToken === '' ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn)
  ) {
    return null;
  }

  return { userId, accessToken, refreshToken, expiresIn };
}

/**
 * Reads the caller's TOTP factors out of a provider user payload.
 *
 * Unknown shapes yield an empty list rather than an error: "no factors" is a state this project handles
 * everywhere, and it is the safe direction — it can only ever cause a challenge to be skipped in favour
 * of enrolment, never the reverse.
 */
function readTotpFactors(body: unknown): readonly TotpFactor[] {
  if (typeof body !== 'object' || body === null) return [];
  const factors = (body as Record<string, unknown>)['factors'];
  if (!Array.isArray(factors)) return [];

  const totp: TotpFactor[] = [];
  for (const entry of factors) {
    if (typeof entry !== 'object' || entry === null) continue;
    const factor = entry as Record<string, unknown>;
    if (factor['factor_type'] !== 'totp') continue;
    const id = factor['id'];
    if (typeof id !== 'string' || id === '') continue;
    totp.push({ id, verified: factor['status'] === 'verified' });
  }
  return totp;
}

/**
 * Reads a TOTP enrolment payload, or null if the secret is not there.
 *
 * The secret is the one field this cannot do without, so its absence is a provider error rather than a
 * partial success: an enrolment screen with no secret is a screen nobody can complete. The QR is
 * optional, and is accepted only when it is a string that really opens as an SVG document — anything
 * else becomes null rather than being passed on for a page to decide about.
 */
function readTotpEnrolment(body: unknown): TotpEnrolment | null {
  if (typeof body !== 'object' || body === null) return null;
  const payload = body as Record<string, unknown>;
  const factorId = payload['id'];
  if (typeof factorId !== 'string' || factorId === '') return null;

  const totp = payload['totp'];
  if (typeof totp !== 'object' || totp === null) return null;
  const details = totp as Record<string, unknown>;

  const secret = details['secret'];
  if (typeof secret !== 'string' || secret === '') return null;

  const qr = details['qr_code'];
  const qrSvg = typeof qr === 'string' && qr.trimStart().startsWith('<svg') ? qr : null;

  return { factorId, secret, qrSvg };
}

/** Reads the fields F4 needs from a provider user payload, or null if the shape is not understood. */
function readUser(body: unknown): SupabaseUser | null {
  if (typeof body !== 'object' || body === null) return null;
  const payload = body as Record<string, unknown>;
  const id = payload['id'];
  if (typeof id !== 'string' || id === '') return null;
  const phone = payload['phone'];
  return { id, phone: typeof phone === 'string' && phone !== '' ? phone : null };
}
