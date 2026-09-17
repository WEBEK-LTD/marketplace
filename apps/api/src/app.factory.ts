import 'reflect-metadata';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { LogController } from 'fastify';
import { AppModule } from './app.module.js';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import type { ApiEnv } from './config/env.js';
import { buildLoggerOptions, REQUEST_ID_HEADER, requestIdFor } from './logging/logger-options.js';
import { NestJsonLogger } from './logging/nest-logger.js';
import { registerRequestTracing } from './telemetry/request-tracing.js';

/** Maximum JSON request body: 1 MiB (owner decision). */
export const BODY_LIMIT_BYTES = 1_048_576;

/**
 * NestJS application options. `bodyParser: false` stops NestJS from registering its extra
 * body parsers (form-urlencoded); only Fastify's JSON parser remains (owner decision: JSON only).
 */
export const NEST_APP_OPTIONS = { bufferLogs: true, bodyParser: false } as const;

/** Media types that must never have a body parser (they are answered with 415). */
const FORBIDDEN_BODY_TYPES = ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'] as const;

export interface AdapterOptions {
  /** Test hook: capture structured log lines. */
  readonly logStream?: { write(line: string): void };
}

export function createFastifyAdapter(env: ApiEnv, options: AdapterOptions = {}): FastifyAdapter {
  return new FastifyAdapter({
    bodyLimit: BODY_LIMIT_BYTES,
    logger: buildLoggerOptions(env.logLevel, options.logStream),
    genReqId: requestIdFor,
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
  });
}

/** Applies the security and error-handling baseline to an application instance. */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance();
  app.useLogger(new NestJsonLogger(fastify.log));
  // Registered first so that every later hook and the handler run inside the request span.
  registerRequestTracing(fastify);

  // helmet security headers; CORS is deliberately never enabled (strict: no cross-origin access).
  await app.register(helmet);

  // JSON-only request bodies: remove Fastify's built-in text/plain parser, then refuse to start
  // if any non-JSON body parser is registered by the time the server is ready.
  fastify.removeContentTypeParser(['text/plain']);
  fastify.addHook('onReady', async () => {
    const present = FORBIDDEN_BODY_TYPES.filter((type) => fastify.hasContentTypeParser(type));
    if (present.length > 0 || !fastify.hasContentTypeParser('application/json')) {
      throw new Error(`Only JSON request bodies are allowed; unexpected parsers: ${present.join(', ') || 'JSON parser missing'}`);
    }
  });

  fastify.addHook('onRequest', async (request, reply) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
  });

  // Graceful shutdown: once closing starts, in-flight responses close their connection so that
  // idle keep-alive connections do not hold the process open until the keep-alive timeout.
  let closing = false;
  fastify.addHook('preClose', async () => {
    closing = true;
  });
  fastify.addHook('onSend', async (_request, reply, payload) => {
    if (closing) {
      void reply.header('connection', 'close');
    }
    return payload;
  });

  // NestJS routes Fastify's own errors (body size, parsing, media type) into this filter as well.
  app.useGlobalFilters(new ProblemDetailsFilter());
}

export async function createApp(env: ApiEnv, options: AdapterOptions = {}): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env),
    createFastifyAdapter(env, options),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  return app;
}
