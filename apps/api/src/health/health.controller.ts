import { Controller, Get, Res } from '@nestjs/common';
import type { HealthResponse, ReadinessResponse } from '@repo/contracts';
import type { FastifyReply } from 'fastify';
import { ReadinessService } from './readiness.js';

/** Internal health checks, outside /v1. */
@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('health')
  health(): HealthResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessResponse> {
    const result = await this.readiness.evaluate();
    if (result.status !== 'ready') {
      void reply.status(503);
    }
    return result;
  }
}
