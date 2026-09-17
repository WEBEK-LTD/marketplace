import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { PROBLEM_JSON_MEDIA_TYPE } from '@repo/contracts';
import { trace } from '@repo/telemetry';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { buildProblem, classifyError, instanceFromUrl } from './problem-details.js';

/** Global filter: every error becomes an RFC 9457 problem response without internal details. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const spec = classifyError(exception);
    if (spec.status >= 500) {
      request.log.error({ err: exception }, 'Unhandled error');
      // The request span records the error type only (O8-13); status is set when the response ends.
      trace.getActiveSpan()?.setAttribute('error.type', exception instanceof Error ? exception.name : typeof exception);
    }
    void reply
      .status(spec.status)
      .header('content-type', `${PROBLEM_JSON_MEDIA_TYPE}; charset=utf-8`)
      .send(JSON.stringify(buildProblem(spec, instanceFromUrl(request.url))));
  }
}
