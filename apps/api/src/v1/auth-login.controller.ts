import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  DEVICE_ID_HEADER,
  DEVICE_ROTATED_HEADER,
  LoginRequestSchema,
  type LoginRequest,
  type LoginResponse,
} from '@repo/contracts';
import { LoginService } from '../auth/login.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/**
 * The shape the BFF receives. It is **not** the browser's response.
 *
 * C-8 puts the browser session in `__Host-` cookies that the BFF sets, so the tokens have to cross
 * exactly one server-to-server hop to reach it. They stop there: the BFF answers the browser with
 * `{ status: 'ok' }` and `Set-Cookie`, and nothing in this envelope is ever forwarded.
 */
export interface LoginSessionEnvelope extends LoginResponse {
  readonly session: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly expiresIn: number;
  };
}

/** Fastify's reply, reduced to the one thing this controller sets. */
interface LoginReplyContext {
  header(name: string, value: string): unknown;
}

/** Fastify's request, reduced to the three things this controller reads. */
interface LoginRequestContext {
  readonly ip?: string;
  readonly headers: Record<string, unknown>;
  readonly id?: unknown;
}

function header(context: LoginRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * `POST /v1/auth/login`.
 *
 * The internal BFF credential guard already covers every `/v1` route, so this controller does not check
 * it again — duplicating that guard would create a second place for it to be got wrong.
 *
 * The controller itself decides nothing about authentication. It validates the body against the shared
 * contract, hands three pieces of request context to {@link LoginService}, and returns. Every failure
 * leaves as a typed error that the problem-details filter renders from the error's own declaration, so
 * there is no `try`/`catch` here mapping outcomes to statuses — and therefore no place where a locked
 * account could accidentally acquire a different status from a wrong password.
 *
 * `@HttpCode(200)` because Nest answers POST with 201 by default and C-2 approves 200.
 */
@Controller('v1/auth')
export class AuthLoginController {
  constructor(private readonly logins: LoginService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() request: LoginRequestContext,
    @Res({ passthrough: true }) reply: LoginReplyContext,
  ): Promise<LoginSessionEnvelope> {
    const session = await this.logins.login({
      identifier: body.identifier,
      password: body.password,
      requestIp: request.ip ?? null,
      userAgent: header(request, 'user-agent'),
      requestId: typeof request.id === 'string' ? request.id : header(request, 'x-request-id'),
      // C-15: the device value the BFF read from the browser's cookie, or issued for it. Absent when
      // the caller sent none; the service then records no device rather than inventing one.
      deviceId: header(request, DEVICE_ID_HEADER),
    });

    // C-15: the browser presented a revoked device and a fresh one was issued. The value goes to the
    // BFF as a header on this internal hop and no further — never into the envelope below, which is
    // the approved login response and gains no field.
    if (session.rotatedDeviceId !== undefined) {
      reply.header(DEVICE_ROTATED_HEADER, session.rotatedDeviceId);
    }

    return {
      status: 'ok',
      session: {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
      },
    };
  }
}
