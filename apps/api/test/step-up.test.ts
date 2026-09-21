import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { OtpPepper } from '../src/auth/otp/otp-digest.js';
import { OTP_PEPPER } from '../src/auth/otp/otp.service.js';
import {
  STEP_UP_STORE,
  StepUpService,
  type IssueStepUpInput,
  type IssueStepUpResult,
  type StepUpOutcome,
  type StepUpStore,
} from '../src/auth/step-up/step-up.service.js';

const PEPPER = 'step-up-test-pepper-not-a-real-secret-0123456789';
const CHALLENGE = '11111111-1111-4111-8111-111111111111';
const GRANT = '33333333-3333-4333-8333-333333333333';

const granted = (over: Partial<IssueStepUpResult> = {}): IssueStepUpResult => ({
  outcome: 'granted',
  grantId: GRANT,
  expiresAt: new Date('2026-09-20T00:10:00Z'),
  ...over,
});

function storeStub(result: IssueStepUpResult = granted()): StepUpStore {
  return {
    issueStepUpGrant: vi.fn(async () => result),
    // Not exercised here; consumption has its own test file.
    runWithStepUpGrant: async (_authorization, operation) => ({ authorized: true, result: await operation() }),
  };
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

const inputOf = (store: StepUpStore): IssueStepUpInput | undefined =>
  (store.issueStepUpGrant as unknown as { mock: { calls: [IssueStepUpInput][] } }).mock.calls[0]?.[0];

describe('issuing a step-up grant from an OTP', () => {
  it('passes the digest, never the submitted code', async () => {
    const store = storeStub();
    const service = await build(store);
    await service.grantFromOtp(CHALLENGE, '012345', 'password_change');

    const input = inputOf(store);
    expect(input?.codeHash).toEqual(new OtpPepper(PEPPER).digest('012345'));
    expect(input?.codeHash).toHaveLength(32);
    expect(JSON.stringify(input)).not.toContain('012345');
  });

  it('carries the challenge and the one operation through unchanged', async () => {
    const store = storeStub();
    const service = await build(store);
    await service.grantFromOtp(CHALLENGE, '012345', 'payout_detail_change');

    expect(inputOf(store)?.challengeId).toBe(CHALLENGE);
    expect(inputOf(store)?.operation).toBe('payout_detail_change');
  });

  it('returns the grant on success', async () => {
    const service = await build(storeStub());
    await expect(service.grantFromOtp(CHALLENGE, '012345', 'password_change')).resolves.toEqual({
      outcome: 'granted',
      grantId: GRANT,
      expiresAt: expect.any(Date),
    });
  });

  it.each([
    ['invalid'],
    ['expired'],
    ['consumed'],
    ['too_many_attempts'],
    ['not_found'],
    ['no_user'],
  ] as const)('passes the %s refusal through with no grant', async (outcome: StepUpOutcome) => {
    const store = storeStub({ outcome, grantId: null, expiresAt: null });
    const service = await build(store);
    const result = await service.grantFromOtp(CHALLENGE, '012345', 'password_change');

    expect(result.outcome).toBe(outcome);
    // A refusal must never come back carrying a grant.
    expect(result.grantId).toBeNull();
    expect(result.expiresAt).toBeNull();
  });

  it('makes exactly one call, so verification and issuance cannot be split by a caller', async () => {
    const store = storeStub();
    const service = await build(store);
    await service.grantFromOtp(CHALLENGE, '012345', 'password_change');
    // One round trip: the database verifies and issues atomically. Two calls would open the race that
    // lets concurrent requests both observe "verified".
    expect(store.issueStepUpGrant).toHaveBeenCalledTimes(1);
  });

  it('does not decide the validity or the recorded source itself', async () => {
    const store = storeStub();
    const service = await build(store);
    await service.grantFromOtp(CHALLENGE, '012345', 'password_change');

    const input = inputOf(store) as unknown as Record<string, unknown>;
    // Neither the 10-minute duration (C-16) nor granted_via is caller-supplied: both are security facts
    // the database derives, so they must not appear in what the service sends.
    expect(Object.keys(input).sort()).toEqual(['challengeId', 'codeHash', 'operation']);
    expect(JSON.stringify(input)).not.toMatch(/otp_whatsapp|granted_via|expires|minutes/i);
  });

  it('distinguishes codes, so a near-miss cannot reuse another digest', async () => {
    const store = storeStub();
    const service = await build(store);
    await service.grantFromOtp(CHALLENGE, '012345', 'password_change');
    const first = inputOf(store)?.codeHash;

    const other = storeStub();
    const service2 = await build(other);
    await service2.grantFromOtp(CHALLENGE, '012346', 'password_change');

    expect(first?.equals(inputOf(other)?.codeHash as Buffer)).toBe(false);
  });
});
