import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ProblemDetailsSchema } from '@repo/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BODY_LIMIT_BYTES, configureApp, createApp, createFastifyAdapter } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { createTestApp, TEST_ENV, type TestApp } from './support/app.js';
import { ProbeModule } from './support/probe.module.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toBe('application/problem+json; charset=utf-8');
  expect(ProblemDetailsSchema.parse(JSON.parse(res.text))).toMatchObject({
    type: 'about:blank',
    status,
    code,
    instance: '/probe/echo',
  });
  expect(res.headers['x-content-type-options']).toBe('nosniff');
}

describe('JSON-only request bodies', () => {
  it('accepts application/json, with or without a charset parameter', async () => {
    const plain = await request(t.app.getHttpServer()).post('/probe/echo').set('content-type', 'application/json').send('{"name":"a"}');
    expect(plain.status).toBe(201);
    const charset = await request(t.app.getHttpServer())
      .post('/probe/echo')
      .set('content-type', 'application/json; charset=utf-8')
      .send('{"name":"b"}');
    expect(charset.status).toBe(201);
    expect(charset.body).toEqual({ name: 'b', size: 0 });
  });

  it('still validates JSON bodies with Zod', async () => {
    expectProblem(await request(t.app.getHttpServer()).post('/probe/echo').send({ name: 5 }), 400, 'VALIDATION_FAILED');
  });

  it('rejects application/x-www-form-urlencoded with 415', async () => {
    const res = await request(t.app.getHttpServer()).post('/probe/echo').type('form').send('name=abc');
    expectProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects text/plain with 415', async () => {
    const res = await request(t.app.getHttpServer()).post('/probe/echo').set('content-type', 'text/plain').send('{"name":"a"}');
    expectProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it.each([
    'application/xml',
    'multipart/form-data; boundary=x',
    'application/octet-stream',
    'text/html',
    'application/problem+json',
    'application/vnd.api+json',
  ])('rejects %s with 415', async (type) => {
    const res = await request(t.app.getHttpServer()).post('/probe/echo').set('content-type', type).send('{"name":"a"}');
    expectProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects oversized JSON with 413', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/probe/echo')
      .set('content-type', 'application/json')
      .send(`{"name":"a","payload":"${'x'.repeat(BODY_LIMIT_BYTES)}"}`);
    expectProblem(res, 413, 'PAYLOAD_TOO_LARGE');
  });

  it('the production app factory enforces the same JSON-only policy', async () => {
    const app = await createApp(TEST_ENV, { logStream: { write: () => undefined } });
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const fastify = app.getHttpAdapter().getInstance();
      expect(fastify.hasContentTypeParser('application/json')).toBe(true);
      expect(fastify.hasContentTypeParser('application/x-www-form-urlencoded')).toBe(false);
      expect(fastify.hasContentTypeParser('text/plain')).toBe(false);
      expect(fastify.hasContentTypeParser('multipart/form-data')).toBe(false);
      // The production app has no routes that accept a body yet; the parser set above is what
      // the request tests exercise through the test application.
    } finally {
      await app.close();
    }
  });

  it('refuses to start if the NestJS extra body parsers are enabled', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV), ProbeModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
      { bodyParser: true },
    );
    await configureApp(app);
    await expect(
      (async () => {
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
      })(),
    ).rejects.toThrow(/Only JSON request bodies are allowed/);
    await app.close().catch(() => undefined);
  });
});
