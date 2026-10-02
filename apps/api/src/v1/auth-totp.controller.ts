import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  SESSION_TOKEN_HEADER,
  TotpChallengeRequestSchema,
  TotpVerifyRequestSchema,
  type TotpChallengeRequest,
  type TotpChallengeResponse,
  type TotpEnrolmentResponse,
  type TotpStatusResponse,
  type TotpVerifyRequest,
  type TotpVerifyResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { TOTP_ISSUER, TotpService } from '../auth/totp/totp.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/**
 * What the BFF receives from a verification. It is **not** the browser's response.
 *
 * The `aal2` session crosses exactly one server-to-server hop, the same way a session does at login and
 * a reset token does in recovery: the BFF turns it into the staff cookies and answers the browser with
 * `{ status: 'verified' }`. This interface is the shape of that hop, and the wall the session never
 * crosses is the BFF, not this file.
 */
export interface TotpVerifyEnvelope extends TotpVerifyResponse {
  readonly session: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly expiresIn: number;
  };
}

/** Fastify's request, reduced to the one thing these routes read. */
interface TotpRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: TotpRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/** The caller's own token, or the refusal that says a session is needed and nothing more. */
function sessionToken(request: TotpRequestContext): string {
  const token = header(request, SESSION_TOKEN_HEADER);
  if (token === null || token === '') throw new AuthenticationRequiredError();
  return token;
}

/**
 * Builds the Key URI an authenticator reads (RFC 6238 / the Key URI Format).
 *
 * **Built here rather than passed through from the provider.** The provider returns a URI of its own, but
 * a URI is what an authenticator stores forever: its issuer, its label, and the algorithm, digit count
 * and period it will use. Constructing it means those are this project's, identical on every enrolment,
 * and that the only value taken from the provider is the secret itself — which is the one thing only the
 * provider can supply.
 *
 * The account label is the issuer and nothing else. It deliberately carries no email address and no phone
 * number: a Key URI is displayed in an authenticator, copied into screenshots and read off shoulders, and
 * an identifier in it would be a contact detail leaving the system for no functional gain.
 */
function otpauthUri(secret: string): string {
  const issuer = encodeURIComponent(TOTP_ISSUER);
  const parameters = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${issuer}?${parameters.toString()}`;
}

/**
 * TOTP enrolment and the AAL2 challenge (Phase 7-B): four routes, all authenticated.
 *
 * The account is taken from the caller's own session token, which the BFF reads from its `__Host-` cookie
 * and presents in `x-session-token`. **No route accepts a user identifier**, so no request can act for
 * somebody else, and none decides a status by hand: every failure leaves the service as a typed error
 * that renders from its own declaration, so a missing session, a wrong code and a provider outage cannot
 * drift apart.
 *
 * Two things are not here, deliberately. **No route removes a factor** and **no route issues backup
 * codes**: the specification makes D9's recovery path depend on O-1 tests 4 and 5, which have not been
 * run, and building either on a guess about provider behaviour would be exactly the wrong thing to guess
 * about. **No route mints a session of its own** — the only session that appears anywhere in this file is
 * the one the provider returned for a satisfied challenge.
 */
@Controller('v1/auth/totp')
export class AuthTotpController {
  constructor(private readonly totp: TotpService) {}

  /** Whether the caller has an authenticator. Two words, for the screen that decides what to offer. */
  @Get()
  @HttpCode(200)
  async status(@Req() request: TotpRequestContext): Promise<TotpStatusResponse> {
    return { status: await this.totp.status(sessionToken(request)) };
  }

  /**
   * Creates a factor and returns the enrolment material, once.
   *
   * This is the only response in the API that carries a shared secret. It is built here from the two
   * values that matter — the secret and a Key URI constructed around it — and the provider's QR document
   * is passed through only when it really is one.
   */
  @Post('enrol')
  @HttpCode(200)
  async enrol(@Req() request: TotpRequestContext): Promise<TotpEnrolmentResponse> {
    const enrolment = await this.totp.enrol(sessionToken(request));
    return {
      status: 'ok',
      secret: enrolment.secret,
      otpauthUri: otpauthUri(enrolment.secret),
      qrSvg: enrolment.qrSvg,
    };
  }

  /**
   * Raises a challenge against the caller's own factor.
   *
   * The factor is chosen by the service from the caller's own factors; the request has no field for one.
   * The two identifiers go back to the BFF, which holds them, so the browser never learns either.
   */
  @Post('challenge')
  @HttpCode(200)
  async challenge(
    @Body(new ZodValidationPipe(TotpChallengeRequestSchema)) body: TotpChallengeRequest,
    @Req() request: TotpRequestContext,
  ): Promise<TotpChallengeResponse> {
    // The operation is deliberately not recorded here. A grant for an unanswered challenge would be a
    // grant nobody proved they should have, so nothing is written until a code comes back; the BFF keeps
    // the choice in its own cookie meanwhile and presents it again at verification.
    void body.operation;
    const challenge = await this.totp.challenge(sessionToken(request));
    return { status: 'ok', challenge };
  }

  /**
   * Satisfies a challenge, and records the step-up grant when one was asked for.
   *
   * The envelope below is the BFF's, not the browser's. Nothing in this method decides what the browser
   * sees — the BFF builds that response from a literal.
   */
  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body(new ZodValidationPipe(TotpVerifyRequestSchema)) body: TotpVerifyRequest,
    @Req() request: TotpRequestContext,
  ): Promise<TotpVerifyEnvelope> {
    const verification = await this.totp.verify({
      accessToken: sessionToken(request),
      factorId: body.factorId,
      challengeId: body.challengeId,
      code: body.code,
      // Supplied by the BFF from the cookie it wrote when the challenge was raised. Absent means the
      // challenge was raised to finish enrolment or to raise the caller's assurance level, and authorises
      // no particular operation — so no grant is recorded.
      operation: body.operation ?? null,
    });

    return {
      status: 'verified',
      session: {
        accessToken: verification.session.accessToken,
        refreshToken: verification.session.refreshToken,
        expiresIn: verification.session.expiresIn,
      },
    };
  }
}
