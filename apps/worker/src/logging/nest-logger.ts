import type { LoggerService } from '@nestjs/common';
import type { WorkerLogger } from './logger.js';

/** Routes NestJS framework logs into the worker's JSON logger. */
export class NestJsonLogger implements LoggerService {
  constructor(private readonly logger: WorkerLogger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }

  error(message: unknown, _trace?: string, context?: string): void {
    this.logger.error({ context }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }

  fatal(message: unknown, context?: string): void {
    this.logger.fatal({ context }, String(message));
  }
}
