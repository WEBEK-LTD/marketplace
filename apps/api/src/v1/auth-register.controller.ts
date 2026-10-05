import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  RegisterRequestSchema,
  RegisterResendRequestSchema,
  RegisterVerifyRequestSchema,
  type RegisterRequest,
  type RegisterResendRequest,
  type RegisterResendResponse,
  type RegisterResponse,
  type RegisterVerifyRequest,
  type RegisterVerifyResponse,
} from '@repo/contracts';
import { RegistrationService } from '../auth/registration.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the three things these routes read. */
interface RegisterRequestContext {
  readonly ip?: string;
  readonly headers?: Record<string, unknown>;
  readonly id?: unknown;
}

function header(context: RegisterRequestContext, name: string): string | null {
  const value = context.headers?.[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * Registration and contact verification (Phase 7-A): `register`, `register/resend` and `register/verify`.
 *
 * Three routes, and they are the whole of the flow's HTTP surface. The internal BFF credential guard
 * already covers every `/v1` route, so neither re-checks it, and neither maps an outcome to a status by
 * hand: every refusal leaves the service as a typed error that renders from its own declaration, which is
 * what keeps a taken address, a wrong code and a spent challenge from acquiring different statuses by
 * accident.
 *
 * Both responses are literals built here. That is the point: there is no value in either of them that
 * varies with whether the account already existed, so no branch in this file — and no branch in the BFF
 * above it — has anything to branch on.
 *
 * Not here, deliberately: any session. Registration signs nobody in, by the approved VERIFY FIRST
 * decision, so neither route returns a session, sets a cookie or touches the login cookies. The person
 * signs in afterwards through `/v1/auth/login` like anyone else.
 */
@Controller('v1/auth')
export class AuthRegisterController {
  constructor(private readonly registration: RegistrationService) {}

  /**
   * Creates the account and sends the code to the phone.
   *
   * The response is identical for an address that is free and one that is already taken: the same status,
   * the same two fields, and a challenge identifier of the same shape either way.
   */
  @Post('register')
  @HttpCode(200)
  async register(
    @Body(new ZodValidationPipe(RegisterRequestSchema)) body: RegisterRequest,
    @Req() request: RegisterRequestContext,
  ): Promise<RegisterResponse> {
    const { challengeId } = await this.registration.register({
      email: body.email,
      phone: body.phone,
      password: body.password,
      displayName: body.displayName,
      requestIp: request.ip ?? null,
      // Hashed inside the service, for the C-20 event a created account writes. Neither value is stored
      // as given, and neither reaches the response.
      userAgent: header(request, 'user-agent'),
      requestId: typeof request.id === 'string' ? request.id : header(request, 'x-request-id'),
    });
    return { status: 'ok', challengeId };
  }

  /**
   * Sends the code again for a registration still in progress.
   *
   * The challenge arrives from the BFF, which read it from its own `HttpOnly` cookie; a browser has no
   * way to supply one. The fresh identifier goes back so the BFF can replace what that cookie holds, and
   * it stops there — the browser is answered with a literal.
   */
  @Post('register/resend')
  @HttpCode(200)
  async resend(
    @Body(new ZodValidationPipe(RegisterResendRequestSchema)) body: RegisterResendRequest,
    @Req() request: RegisterRequestContext,
  ): Promise<RegisterResendResponse> {
    const { challengeId } = await this.registration.resend({
      challengeId: body.challengeId,
      requestIp: request.ip ?? null,
    });
    return { status: 'ok', challengeId };
  }

  /**
   * Confirms the account's contact, which is what lets it sign in for the first time.
   *
   * No session and no token are returned. A wrong code, an expired one, a spent one, a challenge issued
   * for another purpose and a challenge identifier that never belonged to anything are all refused
   * identically.
   */
  @Post('register/verify')
  @HttpCode(200)
  async verify(
    @Body(new ZodValidationPipe(RegisterVerifyRequestSchema)) body: RegisterVerifyRequest,
  ): Promise<RegisterVerifyResponse> {
    await this.registration.verify({
      challengeId: body.challengeId,
      otp: body.otp,
    });
    return { status: 'verified' };
  }
}
