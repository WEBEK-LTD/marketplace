import { describe, expect, it } from 'vitest';
import {
  HealthResponseSchema,
  PROBLEM_CODES,
  ProblemDetailsSchema,
  ReadinessResponseSchema,
} from '../src/index.js';

describe('contract schemas', () => {
  it('accepts a valid health response and nothing else', () => {
    expect(HealthResponseSchema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(HealthResponseSchema.safeParse({ status: 'down' }).success).toBe(false);
    expect(HealthResponseSchema.safeParse({ status: 'ok', extra: 1 }).success).toBe(false);
  });

  it('accepts readiness responses with an empty or populated check list', () => {
    expect(ReadinessResponseSchema.safeParse({ status: 'ready', checks: [] }).success).toBe(true);
    expect(
      ReadinessResponseSchema.safeParse({ status: 'not_ready', checks: [{ name: 'x', status: 'failed' }] }).success,
    ).toBe(true);
    expect(ReadinessResponseSchema.safeParse({ status: 'ready' }).success).toBe(false);
    expect(ReadinessResponseSchema.safeParse({ status: 'ready', checks: [{ name: 'x', status: 'maybe' }] }).success).toBe(false);
  });

  it('describes RFC 9457 problem details with the approved fields', () => {
    const problem = {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'The request is invalid.',
      instance: '/v1/example',
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'name', message: 'Required' }],
    };
    expect(ProblemDetailsSchema.safeParse(problem).success).toBe(true);
    expect(ProblemDetailsSchema.safeParse({ ...problem, type: 'https://example.com' }).success).toBe(false);
    expect(ProblemDetailsSchema.safeParse({ ...problem, status: 200 }).success).toBe(false);
    expect(ProblemDetailsSchema.safeParse({ ...problem, code: 'SOMETHING' }).success).toBe(false);
    expect(ProblemDetailsSchema.safeParse({ ...problem, stack: 'Error: x' }).success).toBe(false);
    expect(PROBLEM_CODES).toContain('VALIDATION_FAILED');
  });
});
