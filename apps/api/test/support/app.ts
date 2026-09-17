import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../../src/app.factory.js';
import { AppModule } from '../../src/app.module.js';
import { loadEnv } from '../../src/config/env.js';
import { READINESS_CHECKS, type ReadinessCheck } from '../../src/health/readiness.js';
import { ProbeModule } from './probe.module.js';

export interface TestApp {
  readonly app: NestFastifyApplication;
  readonly lines: string[];
  logs(): Array<Record<string, unknown>>;
}

export const TEST_ENV = loadEnv({ NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: '3000', LOG_LEVEL: 'info' });

export async function createTestApp(options: { readinessChecks?: readonly ReadinessCheck[] } = {}): Promise<TestApp> {
  const lines: string[] = [];
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV), ProbeModule] });
  if (options.readinessChecks !== undefined) {
    builder = builder.overrideProvider(READINESS_CHECKS).useValue(options.readinessChecks);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: (line: string) => void lines.push(line) } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return {
    app,
    lines,
    logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
