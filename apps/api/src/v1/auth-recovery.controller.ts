import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  RESET_TOKEN_HEADER,
  RecoveryResetRequestSchema,
  RecoveryStartRequestSchema,
  RecoveryVerifyRequestSchema,
  type RecoveryResetRequest,
  type RecoveryResetResponse,
  type RecoveryStartRequest,
  type RecoveryStartResponse,
  type RecoveryVerifyRequest,
  type RecoveryVerifyResponse,
} from '@repo/contracts';
import { InvalidCredentialsError } from '../auth/auth-errors.js';
import { RecoveryService } from '../auth/password-reset/recovery.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/**
 * What the BFF receives from a verification. It is **not** the browser's response.
 *
 * The reset token crosses exactly one server-to-server hop, the same way a session does at login: the
 * BFF turns it into the `__Host-mp_reset` cookie and answers the browser with `{ status: 'ok' }`. The
 * `link` is built here, from `WEB_PUBLIC_ORIGIN`, so the shape of a recovery link is decided on the
 * server and nowhere else; the BFF strips the token out of it before the browser is sent anywhere.
 */
export interface RecoveryVerifyEnvelope extends RecoveryVerifyResponse {
  readonly reset: {
    readonly token: string;
    readonly link: string;
    readonly expiresAt: string;
  };
}

/** Fastify's request, reduced to the four things these routes read. */
interface RecoveryRequestContext {
  readonly ip?: string;
  readonly headers: Record<string, unknown>;
  readonly id?: unknown;
}

function header(context: RecoveryRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

function requestContext(request: RecoveryRequestContext): {
  requestIp: string | null;
  userAgent: string | null;
  requestId: string | null;
} {
  return {
    requestIp: request.ip ?? null,
    userAgent: header(request, 'user-agent'),
    requestId: typeof request.id === 'string' ? request.id : header(request, 'x-request-id'),
  };
}

/**
 * The password-reset recovery flow (F3): `start`, `verify`, `reset`.
 *
 * These three routes are the whole of the flow's HTTP surface. The internal BFF credential guard already
 * covers every `/v1` route, so none of them re-checks it, and none of them maps an outcome to a status
 * by hand: every failure leaves the services as a typed error that renders from its own declaration.
 * That is what keeps a missing account, a wrong code and a spent token from acquiring different statuses
 * by accident.
 *
 * Not here, deliberately: any session. Recovery never signs anyone in, so no route in this file returns
 * a session, sets a cookie or touches the login cookies.
 */
@Controller('v1/auth/recovery')
export class AuthRecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  /**
   * Starts a reset. The response is identical for every identifier, existing or not: a status and a
   * challenge identifier of the same shape.
   */
  @Post('start')
  @HttpCode(200)
  async start(
    @Body(new ZodValidationPipe(RecoveryStartRequestSchema)) body: RecoveryStartRequest,
    @Req() request: RecoveryRequestContext,
  ): Promise<RecoveryStartResponse> {
    const { challengeId } = await this.recovery.start({
      identifier: body.identifier,
      ...requestContext(request),
    });
    return { status: 'ok', challengeId };
  }

  /**
   * Verifies the code and issues the reset token.
   *
   * The envelope below is the BFF's, not the browser's. Nothing in this method decides what the browser
   * sees — the BFF builds that response from a literal.
   */
  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body(new ZodValidationPipe(RecoveryVerifyRequestSchema)) body: RecoveryVerifyRequest,
    @Req() request: RecoveryRequestContext,
  ): Promise<RecoveryVerifyEnvelope> {
    const verification = await this.recovery.verify({
      challengeId: body.challengeId,
      otp: body.otp,
      ...requestContext(request),
    });

    return {
      status: 'ok',
      reset: {
        token: verification.token.reveal(),
        link: verification.link,
        expiresAt: verification.expiresAt.toISOString(),
      },
    };
  }

  /**
   * Completes the reset.
   *
   * The token arrives in the `x-reset-token` header, which the BFF fills from the `__Host-mp_reset`
   * cookie. The browser's body has no field for it, so a browser cannot present one: a request without
   * the header is refused exactly as an invalid token is, and says no more than that.
   */
  @Post('reset')
  @HttpCode(200)
  async reset(
    @Body(new ZodValidationPipe(RecoveryResetRequestSchema)) body: RecoveryResetRequest,
    @Req() request: RecoveryRequestContext,
  ): Promise<RecoveryResetResponse> {
    const token = header(request, RESET_TOKEN_HEADER);
    if (token === null || token === '') throw new InvalidCredentialsError();

    await this.recovery.reset({
      resetToken: token,
      newPassword: body.newPassword,
      ...requestContext(request),
    });
    return { status: 'ok' };
  }
}
