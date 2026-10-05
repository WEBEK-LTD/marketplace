import { BadRequestException } from '@nestjs/common';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';

/**
 * The three things every console route does to a request before anything else sees it.
 *
 * Shared rather than copied, because they are the boundary itself: a token that is absent, a path parameter that
 * cannot name anything, and a body that has not been rebuilt from its contract are the three ways a request gets
 * further than it should. Each existing console controller carries its own copy of these from before this file;
 * nothing here changes their behaviour, and new controllers import rather than restate them.
 */

/** A session token must be present. Its contents are the provider's to judge, never a controller's. */
export function token(value: string | undefined): string {
  if (typeof value !== 'string' || value === '') throw new AuthenticationRequiredError();
  return value;
}

/** A uuid, or a 400. A string that cannot be an identifier never reaches a store. */
export function identifier(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException();
  }
  return value;
}

/** The body is rebuilt from the contract rather than forwarded, so nothing unexpected reaches a writer. */
export function parse<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  body: unknown,
): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException();
  return result.data;
}
