import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  REFRESH_TOKEN_HEADER,
  SESSION_TOKEN_HEADER,
  type LogoutResponse,
  type SessionRefreshResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { SessionService } from '../auth/session.service.js';

/**
 * The shape the BFF receives when a session is renewed. It is **not** the browser's response.
 *
 * Identical in purpose to the login envelope: the tokens cross exactly one server-to-server hop, because
 * the BFF is the only component allowed to mint the browser's `__Host-` cookies (C-8). The browser sees
 * `{ status: 'ok' }` and `Set-Cookie`, and this envelope never leaves the BFF.
 */
export interface SessionRefreshEnvelope extends SessionRefreshResponse {
  readonly session: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly expiresIn: number;
  };
}

/** Fastify's request, reduced to the one thing these routes read. */
interface SessionRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: SessionRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * `POST /v1/auth/refresh` and `POST /v1/auth/logout` (Phase 5-A).
 *
 * Both are session operations and neither is an authentication operation: refresh renews a session the
 * caller already holds, logout ends one. Login is not touched, and nothing here can create a session
 * from credentials.
 *
 * The two routes read different headers on purpose. Refresh takes the **refresh** token, logout takes
 * the **access** token, and neither accepts the other — an access token cannot be spent as a refresh
 * token, and a refresh token cannot be used to end a session it does not name. Both values come from
 * `__Host-` cookies the BFF reads; the browser holds neither in a form it can see.
 *
 * As everywhere else in `/v1`, no status is chosen here: a missing header raises the typed error whose
 * own declaration the problem-details filter renders, so "no session" and "refused session" cannot
 * drift apart between this controller and the rest of the API.
 */
@Controller('v1/auth')
export class AuthSessionController {
  constructor(private readonly sessions: SessionService) {}

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() request: SessionRequestContext): Promise<SessionRefreshEnvelope> {
    const refreshToken = header(request, REFRESH_TOKEN_HEADER);
    if (refreshToken === null || refreshToken === '') throw new AuthenticationRequiredError();

    const session = await this.sessions.refresh(refreshToken);
    return {
      status: 'ok',
      session: {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
      },
    };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() request: SessionRequestContext): Promise<LogoutResponse> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();

    await this.sessions.logout(accessToken);
    return { status: 'ok' };
  }
}
