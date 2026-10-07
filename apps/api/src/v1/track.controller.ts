import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { SESSION_TOKEN_HEADER, TrackRequestSchema, type TrackRequest, type TrackResponse } from '@repo/contracts';
import { ListingEventIngestionService } from '../analytics/listing-events.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the two things this route reads. */
interface TrackRequestContext {
  readonly headers: Record<string, unknown>;
  readonly ip?: string;
}

function header(request: TrackRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * Batched listing analytics ingestion (0101).
 *
 * **The only route in this API that does not need a session** (owner decision 5). It still needs the
 * internal BFF credential, like every `/v1` route — the guard is registered with `APP_GUARD` and nothing
 * skips it — so "unauthenticated" means no account, not no caller: the browser reaches `/api/track` on the
 * web origin and the BFF forwards here. Nothing about that is relaxed for this route.
 *
 * **What it refuses, before anything is written.** A batch over fifty events, an event type outside the four
 * this increment ingests, any field the contract does not name — `userId` and `sessionHash` among them — and
 * a malformed body: all 400, whole, with nothing partially accepted. Over the rate limit is 429. Neither
 * ingestion path available is 503. There is no other answer, and in particular there is no answer that
 * reveals whether a listing exists.
 *
 * **It writes and it reports a count.** `accepted` is how many events the server took responsibility for,
 * not how many rows reached the table: de-duplication happens downstream and a retried batch legitimately
 * writes none. A client has no use for the row count, and giving it one would invite a retry on a zero.
 */
@Controller('v1')
export class TrackController {
  constructor(private readonly ingestion: ListingEventIngestionService) {}

  @Post('track')
  @HttpCode(202)
  async track(
    @Req() request: TrackRequestContext,
    @Body(new ZodValidationPipe(TrackRequestSchema)) body: TrackRequest,
  ): Promise<TrackResponse> {
    const result = await this.ingestion.ingest({
      events: body.events,
      // The opaque identifier, exactly as the browser carried it. It is hashed in the service under the
      // analytics key; nothing a caller sends can become the stored digest.
      sessionId: body.sessionId ?? null,
      // Present only for a signed-in caller. The service resolves it to an account, and treats anything
      // unusable as anonymous rather than refusing a beacon whose token expired while the page was open.
      accessToken: header(request, SESSION_TOKEN_HEADER),
      requestIp: request.ip ?? null,
    });

    return { accepted: result.accepted };
  }
}
