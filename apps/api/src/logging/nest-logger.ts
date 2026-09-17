import type { LoggerService } from '@nestjs/common';
import type { FastifyBaseLogger } from 'fastify';

/** Routes NestJS framework logs into the same structured JSON logger. */
export class NestJsonLogger implements LoggerService {
  constructor(private readonly logger: FastifyBaseLogger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ module: 'nest', context }, String(message));
  }

  error(message: unknown, _trace?: string, context?: string): void {
    this.logger.error({ module: 'nest', context }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ module: 'nest', context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ module: 'nest', context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ module: 'nest', context }, String(message));
  }

  fatal(message: unknown, context?: string): void {
    this.logger.fatal({ module: 'nest', context }, String(message));
  }
}
