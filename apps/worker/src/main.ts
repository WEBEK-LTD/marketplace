import './runtime/pure-js-msgpack.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { initTelemetry } from '@repo/telemetry';
import { EnvValidationError, loadEnv, workerConfigLoadedEvent } from './config/env.js';
import { createLogger, errorSummary } from './logging/logger.js';
import { NestJsonLogger } from './logging/nest-logger.js';
import { WorkerRuntime } from './runtime/worker-runtime.js';
import { WorkerModule } from './worker.module.js';

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  // Telemetry first (O8-16): process-wide tracer provider, no export, no propagator.
  const telemetry = initTelemetry({ serviceName: 'worker' });
  const logger = createLogger(env.logLevel);
  // Safe metadata only: no configuration values and no variable names (owner decision R11).
  logger.info({ module: 'config', ...workerConfigLoadedEvent() }, 'Configuration loaded');
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env, logger), {
    logger: new NestJsonLogger(logger),
  });
  const runtime = app.get(WorkerRuntime);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runtime
      .stop(signal)
      .then(() => app.close())
      // Bounded telemetry shutdown after the job drain (O8-17).
      .then(() => telemetry.shutdown())
      .then(() => process.exit(runtime.fatal === undefined ? 0 : 1))
      .catch(() => process.exit(1));
  };
  runtime.onFatal(() => shutdown('fatal'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await runtime.start();
  } catch (error) {
    logger.fatal({ event: 'worker_start_failed', ...errorSummary(error) }, 'Worker failed to start');
    await runtime.stop('startup_failure').catch(() => undefined);
    await app.close().catch(() => undefined);
    process.exit(1);
  }
}

main().catch(() => {
  process.stderr.write('Worker failed to start.\n');
  process.exit(1);
});
