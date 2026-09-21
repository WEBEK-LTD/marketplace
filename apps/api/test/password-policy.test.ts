import { PASSWORD_ISSUE, PasswordSchema } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { buildProblem, classifyError } from '../src/common/problem-details.js';
import { RequestValidationException } from '../src/common/request-validation.exception.js';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe.js';
import { z } from 'zod';

/**
 * The API consumes the shared D1 rule rather than restating it.
 *
 * There is no login or registration endpoint yet — those need decisions the specification has not made —
 * so this exercises the rule through the validation pipe the API already uses, which is how any future
 * endpoint will reach it. What it proves is that D1 is enforced on the API side of the boundary, before
 * a password could ever be handed to the auth provider.
 */
const BodySchema = z.object({ password: PasswordSchema }).strict();
const pipe = new ZodValidationPipe(BodySchema);

const ARABIC = 'ب';

describe('the API enforces D1 through the shared rule', () => {
  it('accepts a compliant password and passes it through byte-for-byte', () => {
    const password = `${'pass'}${ARABIC.repeat(34)}`; // 72 UTF-8 bytes
    expect(new TextEncoder().encode(password).length).toBe(72);
    expect(pipe.transform({ password })).toEqual({ password });
  });

  it('rejects a password over 72 UTF-8 bytes before anything downstream sees it', () => {
    expect(() => pipe.transform({ password: ARABIC.repeat(40) })).toThrow(RequestValidationException);
  });

  it('rejects a password under 10 characters', () => {
    expect(() => pipe.transform({ password: 'short' })).toThrow(RequestValidationException);
  });

  it('reports the failure on the password field, using the established validation contract', () => {
    let thrown: unknown;
    try {
      pipe.transform({ password: 'short' });
    } catch (error) {
      thrown = error;
    }

    const problem = buildProblem(classifyError(thrown), '/test');
    // 400 VALIDATION_FAILED is the Phase 1 decision; this step introduces no new status code.
    expect(problem.status).toBe(400);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.map((issue) => issue.path)).toContain('password');
  });

  it('never puts the password in the problem response', () => {
    const password = 'Xq7#vZ';
    let thrown: unknown;
    try {
      pipe.transform({ password });
    } catch (error) {
      thrown = error;
    }
    expect(JSON.stringify(buildProblem(classifyError(thrown), '/test'))).not.toContain(password);
  });

  it('does not truncate an over-long password anywhere in the rejection', () => {
    const password = ARABIC.repeat(50); // 100 bytes
    let thrown: unknown;
    try {
      pipe.transform({ password });
    } catch (error) {
      thrown = error;
    }
    expect(JSON.stringify(buildProblem(classifyError(thrown), '/test'))).not.toContain(ARABIC.repeat(36));
  });

  it('carries the stable rule identifier so a caller need not parse messages', () => {
    const result = PasswordSchema.safeParse('short');
    expect(result.success).toBe(false);
    if (!result.success) {
      const rules = result.error.issues.map(
        (issue) => (issue as { params?: { rule?: unknown } }).params?.rule,
      );
      expect(rules).toContain(PASSWORD_ISSUE.tooShort);
    }
  });
});
