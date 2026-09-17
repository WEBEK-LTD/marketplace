import 'reflect-metadata';
import { initTelemetry } from '@repo/telemetry';
import { createApp } from './app.factory.js';
import { apiConfigLoadedEvent, EnvValidationError, loadEnv } from './config/env.js';

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
  const telemetry = initTelemetry({ serviceName: 'api' });
  const app = await createApp(env);
  // Bounded telemetry shutdown as part of the existing graceful shutdown (O8-17).
  app.getHttpAdapter().getInstance().addHook('onClose', async () => {
    await telemetry.shutdown();
  });
  // Safe metadata only: no configuration values and no variable names (owner decision R11).
  app.getHttpAdapter().getInstance().log.info({ module: 'config', ...apiConfigLoadedEvent() }, 'Configuration loaded');
  // Graceful shutdown: stop accepting connections and finish in-flight requests on SIGTERM/SIGINT.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT'], { useProcessExit: true });
  await app.listen({ host: env.host, port: env.port });
}

main().catch(() => {
  process.stderr.write('API failed to start.\n');
  process.exit(1);
});
