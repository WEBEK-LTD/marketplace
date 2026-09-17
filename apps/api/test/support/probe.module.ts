import { Body, ConflictException, Controller, Get, Module, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ZodValidationPipe } from '../../src/common/zod-validation.pipe.js';

// Test-only routes used to exercise validation, errors, logging and shutdown.
export const EchoSchema = z.object({ name: z.string().min(1), payload: z.string().optional() }).strict();
export const QuerySchema = z.object({ page: z.coerce.number().int().min(1) }).strict();
export const INTERNAL_DETAIL_MARKER = 'internal-detail-marker-must-not-leak';

@Controller('probe')
export class ProbeController {
  @Post('echo')
  echo(@Body(new ZodValidationPipe(EchoSchema)) body: z.infer<typeof EchoSchema>): { name: string; size: number } {
    return { name: body.name, size: body.payload?.length ?? 0 };
  }

  @Get('query')
  query(@Query(new ZodValidationPipe(QuerySchema)) query: z.infer<typeof QuerySchema>): { page: number } {
    return { page: query.page };
  }

  @Get('boom')
  boom(): never {
    throw new Error(INTERNAL_DETAIL_MARKER);
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException(INTERNAL_DETAIL_MARKER);
  }

  @Get('slow')
  async slow(): Promise<{ done: true }> {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { done: true };
  }

  @Post('log-headers')
  logHeaders(@Req() request: FastifyRequest): { logged: true } {
    request.log.info({ headers: request.headers }, 'probe headers');
    return { logged: true };
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
