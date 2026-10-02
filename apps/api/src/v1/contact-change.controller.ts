import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  ContactPhoneStartRequestSchema,
  ContactPhoneVerifyRequestSchema,
  SESSION_TOKEN_HEADER,
  type ContactPhoneStartRequest,
  type ContactPhoneStartResponse,
  type ContactPhoneVerifyRequest,
  type ContactPhoneVerifyResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { ContactChangeService } from '../users/contact-change.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/**
 * What the BFF receives when a change is started. It is **not** the browser's response.
 *
 * The approved public body is `{ status: 'ok' }`; the challenge identifier travels on the one internal
 * hop so the BFF can hand it to the second step, exactly as a session travels at login and a reset token
 * travels in recovery. It is an opaque identifier, not a credential: the code itself went to the phone.
 */
export interface ContactPhoneStartEnvelope extends ContactPhoneStartResponse {
  readonly challenge: { readonly id: string };
}

/** Fastify's request, reduced to the four things these routes read. */
interface ContactRequestContext {
  readonly ip?: string;
  readonly headers: Record<string, unknown>;
  readonly id?: unknown;
}

function header(context: ContactRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * The phone contact change (F4): `start` and `verify`, both authenticated.
 *
 * The account is taken from the caller's own session token, which the BFF reads from its `__Host-`
 * cookie and presents in `x-session-token`. Neither route accepts a user identifier, and neither
 * decides a status by hand: every failure leaves the service as a typed error that renders from its own
 * declaration, so a missing session, a refused code and a provider outage cannot drift apart.
 *
 * Not here, deliberately: any session change. A contact change creates no session and revokes none.
 */
@Controller('v1/users/me/contact/phone')
export class ContactChangeController {
  constructor(private readonly contacts: ContactChangeService) {}

  @Post('start')
  @HttpCode(200)
  async start(
    @Body(new ZodValidationPipe(ContactPhoneStartRequestSchema)) body: ContactPhoneStartRequest,
    @Req() request: ContactRequestContext,
  ): Promise<ContactPhoneStartEnvelope> {
    const { challengeId } = await this.contacts.start({
      phone: body.phone,
      ...this.context(request),
    });
    return { status: 'ok', challenge: { id: challengeId } };
  }

  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body(new ZodValidationPipe(ContactPhoneVerifyRequestSchema)) body: ContactPhoneVerifyRequest,
    @Req() request: ContactRequestContext,
  ): Promise<ContactPhoneVerifyResponse> {
    await this.contacts.verify({
      challengeId: body.challengeId,
      otp: body.otp,
      ...this.context(request),
    });
    return { status: 'ok' };
  }

  /** The caller's session and the request context. A request without a session never reaches a service. */
  private context(request: ContactRequestContext): {
    accessToken: string;
    requestIp: string | null;
    userAgent: string | null;
    requestId: string | null;
  } {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return {
      accessToken,
      requestIp: request.ip ?? null,
      userAgent: header(request, 'user-agent'),
      requestId: typeof request.id === 'string' ? request.id : header(request, 'x-request-id'),
    };
  }
}
