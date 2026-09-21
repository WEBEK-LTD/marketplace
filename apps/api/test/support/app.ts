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

// The app_system pool is created lazily by node-postgres, so an unreachable host costs nothing here:
// none of these tests exercise the auth enforcement path, which has its own tests with a stub store.
/** Obviously fake, 43 base64url characters like the real format. */
export const TEST_INTERNAL_CREDENTIAL = 'test-current-credential-value-not-a-real-se';

export const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  LOG_LEVEL: 'info',
  APP_SYSTEM_DATABASE_URL: 'postgresql://app_system@db.invalid:5432/marketplace',
  OTP_PEPPER: 'test-otp-pepper-value-not-a-real-secret-0123456789',
  WAABEK_BASE_URL: 'https://waabek.invalid',
  WAABEK_API_KEY: 'test-waabek-key-not-a-real-secret',
  INTERNAL_BFF_CREDENTIAL: TEST_INTERNAL_CREDENTIAL,
});

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
