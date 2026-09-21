import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountLockedError,
  EnforcementUnavailableError,
  GENERIC_AUTH_FAILURE_MESSAGE,
} from '../src/auth/auth-errors.js';
import {
  LOGIN_ENFORCEMENT_STORE,
  LoginEnforcementService,
  type LoginAttempt,
  type LoginEnforcementStore,
} from '../src/auth/login-enforcement.service.js';

const attempt = (overrides: Partial<LoginAttempt> = {}): LoginAttempt => ({
  userId: '00000000-0000-4000-8000-000000000001',
  identifierHash: Buffer.alloc(32, 1),
  succeeded: false,
  failureReason: 'bad_credentials',
  requestIp: '198.51.100.7',
  userAgentHash: null,
  ...overrides,
});

function storeStub(overrides: Partial<LoginEnforcementStore> = {}): LoginEnforcementStore {
  return {
    isAccountLocked: vi.fn(async () => false),
    recordLoginAttempt: vi.fn(async () => false),
    ...overrides,
  };
}

async function serviceWith(store: LoginEnforcementStore): Promise<LoginEnforcementService> {
  const moduleRef = await Test.createTestingModule({
    providers: [LoginEnforcementService, { provide: LOGIN_ENFORCEMENT_STORE, useValue: store }],
  }).compile();
  return moduleRef.get(LoginEnforcementService);
}

describe('durable lockout gate', () => {
  let store: LoginEnforcementStore;
  let service: LoginEnforcementService;

  beforeEach(async () => {
    store = storeStub();
    service = await serviceWith(store);
  });

  it('allows an account that holds no lockout', async () => {
    await expect(service.assertNotLocked('00000000-0000-4000-8000-000000000001')).resolves.toBeUndefined();
    expect(store.isAccountLocked).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
  });

  it('refuses a locked account', async () => {
    service = await serviceWith(storeStub({ isAccountLocked: vi.fn(async () => true) }));
    await expect(service.assertNotLocked('00000000-0000-4000-8000-000000000001')).rejects.toBeInstanceOf(
      AccountLockedError,
    );
  });

  it('passes an unknown identifier through without consulting the database', async () => {
    // There is no account to be locked. The caller still records the failure.
    await expect(service.assertNotLocked(null)).resolves.toBeUndefined();
    expect(store.isAccountLocked).not.toHaveBeenCalled();
  });
});

describe('failing closed', () => {
  it('denies the attempt when the lockout check throws', async () => {
    const service = await serviceWith(
      storeStub({
        isAccountLocked: vi.fn(async () => {
          throw new Error('connection refused');
        }),
      }),
    );
    // The tempting bug is to treat an error as "not locked". That would turn an outage into an open door.
    await expect(service.assertNotLocked('00000000-0000-4000-8000-000000000001')).rejects.toBeInstanceOf(
      EnforcementUnavailableError,
    );
  });

  it('denies the attempt when recording throws', async () => {
    const service = await serviceWith(
      storeStub({
        recordLoginAttempt: vi.fn(async () => {
          throw new Error('connection refused');
        }),
      }),
    );
    await expect(service.recordAttempt(attempt())).rejects.toBeInstanceOf(EnforcementUnavailableError);
  });

  it('keeps the underlying cause for alerting without exposing it', async () => {
    const cause = new Error('password authentication failed for user "app_system"');
    const service = await serviceWith(
      storeStub({
        isAccountLocked: vi.fn(async () => {
          throw cause;
        }),
      }),
    );
    const error = await service
      .assertNotLocked('00000000-0000-4000-8000-000000000001')
      .then(() => null)
      .catch((caught: unknown) => caught as EnforcementUnavailableError);

    expect(error?.cause).toBe(cause);
    expect(error?.message).toBe(GENERIC_AUTH_FAILURE_MESSAGE);
    expect(error?.message).not.toContain('app_system');
  });
});

describe('recording an attempt', () => {
  it('reports that the account became locked', async () => {
    const service = await serviceWith(storeStub({ recordLoginAttempt: vi.fn(async () => true) }));
    await expect(service.recordAttempt(attempt())).resolves.toBe(true);
  });

  it('passes the attempt through unchanged, including a null user id', async () => {
    const store = storeStub();
    const service = await serviceWith(store);
    const unknown = attempt({ userId: null, failureReason: 'no_such_user' });
    await service.recordAttempt(unknown);
    expect(store.recordLoginAttempt).toHaveBeenCalledWith(unknown);
  });
});

describe('generic error messages', () => {
  it('gives a locked account and an unavailable database the same message', () => {
    // "Generic error message always": the caller must not be able to distinguish these.
    expect(new AccountLockedError().message).toBe(GENERIC_AUTH_FAILURE_MESSAGE);
    expect(new EnforcementUnavailableError(new Error('x')).message).toBe(GENERIC_AUTH_FAILURE_MESSAGE);
  });

  it('does not reveal whether the account exists', () => {
    expect(new AccountLockedError().message).not.toMatch(/lock|exist|account|user|password/i);
  });
});
