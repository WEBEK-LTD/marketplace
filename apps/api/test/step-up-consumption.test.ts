import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { OtpPepper } from '../src/auth/otp/otp-digest.js';
import { OTP_PEPPER } from '../src/auth/otp/otp.service.js';
import {
  STEP_UP_STORE,
  StepUpService,
  type AuthorizedRun,
  type StepUpAuthorization,
  type StepUpStore,
} from '../src/auth/step-up/step-up.service.js';

const PEPPER = 'consume-test-pepper-not-a-real-secret-0123456789';
const AUTH: StepUpAuthorization = {
  grantId: '44444444-4444-4444-8444-444444444444',
  userId: '55555555-5555-4555-8555-555555555555',
  operation: 'password_change',
};

/**
 * A store that behaves like the database one: the grant is consumed before the operation runs, and the
 * consumption is rolled back if the operation throws. That is the contract
 * `AppSystemStore.runWithStepUpGrant` implements with a real transaction.
 */
function transactionalStore(options: { consumable?: boolean } = {}) {
  // A generic method loses its signature through `vi.fn`, so calls are recorded here instead.
  const state = {
    consumed: false,
    consumeCalls: 0,
    operationCalls: 0,
    authorizations: [] as StepUpAuthorization[],
  };
  const consumable = options.consumable ?? true;

  const store: StepUpStore = {
    issueStepUpGrant: vi.fn(async () => ({ outcome: 'granted' as const, grantId: AUTH.grantId, expiresAt: null })),
    runWithStepUpGrant: async <T,>(auth: StepUpAuthorization, operation: () => Promise<T>) => {
      state.consumeCalls += 1;
      state.authorizations.push(auth);
      if (!consumable || state.consumed) return { authorized: false } as AuthorizedRun<T>;
      state.consumed = true; // inside the transaction
      try {
        state.operationCalls += 1;
        const result = await operation();
        return { authorized: true, result } as AuthorizedRun<T>;
      } catch (error) {
        state.consumed = false; // rollback gives the grant back
        throw error;
      }
    },
  };
  return { store, state };
}

async function build(store: StepUpStore) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      StepUpService,
      { provide: STEP_UP_STORE, useValue: store },
      { provide: OTP_PEPPER, useValue: new OtpPepper(PEPPER) },
    ],
  }).compile();
  return moduleRef.get(StepUpService);
}

describe('authorising a protected operation', () => {
  it('runs the operation and returns its result when the grant is consumable', async () => {
    const { store, state } = transactionalStore();
    const service = await build(store);

    const outcome = await service.authorize(AUTH, async () => 'operation-result');

    expect(outcome).toEqual({ authorized: true, result: 'operation-result' });
    expect(state.consumed).toBe(true);
    expect(state.operationCalls).toBe(1);
  });

  it('does not run the operation when the grant cannot be consumed', async () => {
    const { store, state } = transactionalStore({ consumable: false });
    const service = await build(store);
    const operation = vi.fn(async () => 'should not happen');

    expect(await service.authorize(AUTH, operation)).toEqual({ authorized: false });
    expect(operation).not.toHaveBeenCalled();
    expect(state.consumed).toBe(false);
  });

  it('passes the grant, user and operation through unchanged', async () => {
    const { store, state } = transactionalStore();
    const service = await build(store);
    await service.authorize(AUTH, async () => null);

    expect(state.authorizations).toEqual([AUTH]);
  });
});

describe('a failed operation gives the grant back (C-19 rule 4)', () => {
  it('re-throws the failure and leaves the grant unconsumed', async () => {
    const { store, state } = transactionalStore();
    const service = await build(store);
    const failure = new Error('business rule rejected this');

    await expect(
      service.authorize(AUTH, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    // The rollback returned it: the grant is still spendable.
    expect(state.consumed).toBe(false);
  });

  it('lets a later attempt succeed after the earlier one failed', async () => {
    const { store, state } = transactionalStore();
    const service = await build(store);

    await expect(
      service.authorize(AUTH, async () => {
        throw new Error('provider unavailable');
      }),
    ).rejects.toThrow('provider unavailable');

    expect(await service.authorize(AUTH, async () => 'second attempt')).toEqual({
      authorized: true,
      result: 'second attempt',
    });
    expect(state.consumed).toBe(true);
  });
});

describe('single use (C-19 rules 1 and 6)', () => {
  it('refuses a second successful use of the same grant', async () => {
    const { store, state } = transactionalStore();
    const service = await build(store);

    expect(await service.authorize(AUTH, async () => 'first')).toEqual({ authorized: true, result: 'first' });
    expect(await service.authorize(AUTH, async () => 'second')).toEqual({ authorized: false });
    expect(state.operationCalls).toBe(1);
  });

  it('allows at most one of several simultaneous attempts to run the operation', async () => {
    const { store, state } = transactionalStore();
    const service = await build(store);

    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => service.authorize(AUTH, async () => `run-${i}`)),
    );

    expect(attempts.filter((attempt) => attempt.authorized)).toHaveLength(1);
    expect(state.operationCalls).toBe(1);
  });
});

describe('the service adds no policy of its own', () => {
  it('delegates authorisation entirely to the database primitive', async () => {
    const { store, state } = transactionalStore();
    const service = await build(store);
    await service.authorize(AUTH, async () => null);
    // Exactly one call: no pre-check, which would be the read-then-write race the design avoids.
    expect(state.consumeCalls).toBe(1);
  });

  it('does not decide validity, expiry or eligibility in TypeScript', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/auth/step-up/step-up.service.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // `expiresAt` is a data field on the issuance result, which is fine. What must not be here is any
    // decision about time or consumption: no clock arithmetic, no duration, no writing consumed_at.
    expect(code).not.toMatch(/Date\.now|new Date\(|minutes|consumed_at|setHours|getTime/);
  });
});
