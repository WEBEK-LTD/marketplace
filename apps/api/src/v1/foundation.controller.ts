import { Controller, Get } from '@nestjs/common';
import type { V1FoundationResponse } from '@repo/contracts';

/**
 * The `/v1` foundation probe.
 *
 * Its only job is to prove the boundary: that `/v1` exists, that the internal BFF credential guard runs
 * in front of it, and that a refusal renders as generic problem details. It is not a business route and
 * it is emphatically not an authentication route — it reads no credential, no token and no user, and it
 * returns nothing that varies by caller. Reaching it means "an approved internal runtime called us", and
 * nothing more.
 */
@Controller('v1')
export class FoundationController {
  @Get('foundation')
  foundation(): V1FoundationResponse {
    return { status: 'ok' };
  }
}
