import { Controller, Get, Req } from '@nestjs/common';
import { SESSION_TOKEN_HEADER, type AdminSessionResponse } from '@repo/contracts';
import { StaffConsoleService } from '../admin/staff-console.service.js';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';

/** Fastify's request, reduced to the one thing this route reads. */
interface AdminRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: AdminRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * The staff console session (Phase 7-F).
 *
 * **One route, one method, no parameters.** There is no path parameter, no query string and no body on
 * this controller — nothing a caller could put a user identifier, a role, a permission or an assurance
 * claim into. The session is read from the caller's own access token and from nowhere else.
 *
 * The controller decides nothing about who may do what. The assurance rule is 0003's and is applied in
 * migration 0068; the permission set that comes back is already effective. Restating any of it here
 * would be a second copy of an authorization rule, which is how two copies start to disagree.
 *
 * **Not here, deliberately: no write of any kind.** No role assignment, no permission grant, no
 * assurance assertion, no step-up issuance. Reaching `aal2` is the existing TOTP flow of 7-B and
 * nothing on this path can substitute for it.
 */
@Controller('v1/admin')
export class AdminSessionController {
  constructor(private readonly console: StaffConsoleService) {}

  @Get('session')
  async session(@Req() request: AdminRequestContext): Promise<AdminSessionResponse> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return { session: await this.console.forToken(accessToken) };
  }
}
