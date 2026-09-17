import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  apiClient,
  configureApiClient,
  generateOpenApiDocument,
  HealthResponseSchema,
  ReadinessResponseSchema,
  resetApiClient,
} from '@repo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory.js';
import { TEST_ENV } from './support/app.js';

// TOOL-2: Zod contracts -> OpenAPI -> generated client, exercised against the real application.
let app: NestFastifyApplication;
beforeAll(async () => {
  app = await createApp(TEST_ENV, { logStream: { write: () => undefined } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.getHttpServer().address() as AddressInfo;
  configureApiClient({ baseUrl: `http://127.0.0.1:${port}` });
});
afterAll(async () => {
  resetApiClient();
  await app.close();
});

describe('TOOL-2: generated client against the running API', () => {
  it('getHealth returns data matching the Zod contract', async () => {
    const result = await apiClient.getHealth();
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(HealthResponseSchema.parse(result.data)).toEqual({ status: 'ok' });
    }
  });

  it('getReadiness returns data matching the Zod contract', async () => {
    const result = await apiClient.getReadiness();
    expect(result.status).toBe(200);
    expect(ReadinessResponseSchema.parse(result.data)).toEqual({ status: 'ready', checks: [] });
    expect(result.headers.get('x-request-id')).toBeTruthy();
  });

  it('every documented operation exists in the production application', () => {
    const fastify = app.getHttpAdapter().getInstance();
    const doc = generateOpenApiDocument();
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const method of Object.keys(item as object)) {
        expect(fastify.hasRoute({ method: method.toUpperCase() as 'GET', url: path }), `${method} ${path}`).toBe(true);
      }
    }
  });

  it('the production application exposes no OpenAPI document', async () => {
    for (const path of ['/openapi.json', '/docs', '/api-docs', '/swagger']) {
      const res = await fetch(`${app.getHttpServer().address() === null ? '' : `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`}${path}`);
      expect(res.status, path).toBe(404);
    }
  });
});
