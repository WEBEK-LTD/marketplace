import { Controller, Get, Req } from '@nestjs/common';
import { SESSION_TOKEN_HEADER, type CurrentUserResponse } from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing this route reads. */
interface CurrentUserRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: CurrentUserRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * `GET /v1/users/me` (Phase 5-A).
 *
 * The one route that answers "who am I". It takes no parameter and no body: the account comes from the
 * caller's own access token, which the BFF reads from its `__Host-mp_access` cookie and presents in
 * `x-session-token`. There is deliberately no `/v1/users/:id` beside it — a route that accepted an
 * identifier would be a route somebody could point at another account.
 *
 * The response carries the account id and the display name, by owner decision, and the service takes
 * that projection from the database reader rather than assembling it, so this controller has no field
 * of its own to leak.
 */
@Controller('v1/users')
export class CurrentUserController {
  constructor(private readonly users: CurrentUserService) {}

  @Get('me')
  async me(@Req() request: CurrentUserRequestContext): Promise<CurrentUserResponse> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return { user: await this.users.forToken(accessToken) };
  }
}
