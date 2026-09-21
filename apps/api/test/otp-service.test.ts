import { readFileSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { OtpPepper } from '../src/auth/otp/otp-digest.js';
import {
  OTP_CHALLENGE_STORE,
  OTP_PEPPER,
  OtpService,
  type IssueOtpInput,
  type IssueOtpResult,
  type OtpChallengeStore,
} from '../src/auth/otp/otp.service.js';
import { WaabekClient } from '../src/auth/otp/waabek.client.js';

const PEPPER = 'service-test-pepper-not-a-real-secret-0123456789';
const CHALLENGE = '11111111-1111-4111-8111-111111111111';
const OUTBOX = '22222222-2222-4222-8222-222222222222';

const issued = (over: Partial<IssueOtpResult> = {}): IssueOtpResult => ({
  outcome: 'issued',
  challengeId: CHALLENGE,
  outboxId: OUTBOX,
  sendCount: 1,
  retryAfterSeconds: null,
  expiresAt: new Date('2026-09-20T00:10:00Z'),
  ...over,
});

function storeStub(over: Partial<OtpChallengeStore> = {}): OtpChallengeStore {
  return {
    issueOtpChallenge: vi.fn(async () => issued()),
    beginOtpDelivery: vi.fn(async () => true),
    settleOtpDelivery: vi.fn(async () => true),
    verifyOtpChallenge: vi.fn(async () => 'verified' as const),
    ...over,
  };
}

type SendMock = ReturnType<typeof defaultSend>;
const defaultSend = () =>
  vi.fn(async (_to: string, _message: string) => ({ status: 'sent' as const, providerMessageId: 'wam-1' }));

async function build(store: OtpChallengeStore, send: SendMock = defaultSend()) {
  const client = { send } as unknown as WaabekClient & { send: SendMock };
  const moduleRef = await Test.createTestingModule({
    providers: [
      OtpService,
      { provide: OTP_CHALLENGE_STORE, useValue: store },
      { provide: OTP_PEPPER, useValue: new OtpPepper(PEPPER) },
      { provide: WaabekClient, useValue: client },
    ],
  }).compile();
  return { service: moduleRef.get(OtpService), client };
}

const request = () => ({
  purpose: 'phone_verify',
  toPhoneE164: '+201000000001',
  destinationHash: Buffer.alloc(32, 7),
  templateName: 'otp_login',
  templateLocale: 'en',
  ipHash: Buffer.alloc(32, 9),
  requestIp: '198.51.100.9',
  composeMessage: (code: string) => `Your code is ${code}`,
});

describe('issuing an OTP', () => {
  it('stores a digest, never the code', async () => {
    const store = storeStub();
    const { service } = await build(store);
    await service.sendWhatsAppOtp(request());

    const input = (store.issueOtpChallenge as unknown as { mock: { calls: [IssueOtpInput][] } }).mock.calls[0]?.[0];
    expect(input?.codeHash).toHaveLength(32);
    // Whatever code was generated, its plaintext must not be anywhere in what reaches the database.
    expect(JSON.stringify(input)).not.toMatch(/"[0-9]{6}"/);
  });

  it('sends the code to the provider and returns it to nobody', async () => {
    const { service, client } = await build(storeStub());
    const result = await service.sendWhatsAppOtp(request());

    const message = String(client.send.mock.calls[0]?.[1]);
    const code = /(\d{6})/.exec(message)?.[1];
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(result).toEqual({ status: 'sent', challengeId: CHALLENGE, expiresAt: expect.any(Date) });
    // The caller must not be able to read the code back out of the result.
    expect(JSON.stringify(result)).not.toContain(code as string);
  });

  it('records the challenge before contacting the provider', async () => {
    const order: string[] = [];
    const store = storeStub({
      issueOtpChallenge: vi.fn(async () => {
        order.push('issue');
        return issued();
      }),
    });
    const { service } = await build(
      store,
      vi.fn(async () => {
        order.push('send');
        return { status: 'sent' as const, providerMessageId: null };
      }) as unknown as SendMock,
    );
    await service.sendWhatsAppOtp(request());
    // Limits are enforced inside issue, so the provider must never be reached first.
    expect(order).toEqual(['issue', 'send']);
  });

  it('settles the outbox as sent only after the provider accepts', async () => {
    const store = storeStub();
    const { service } = await build(store);
    await service.sendWhatsAppOtp(request());
    expect(store.settleOtpDelivery).toHaveBeenCalledWith({
      outboxId: OUTBOX,
      status: 'sent',
      providerMessageId: 'wam-1',
      errorType: null,
    });
  });

  it('returns cooldown without contacting the provider', async () => {
    const store = storeStub({
      issueOtpChallenge: vi.fn(async () => issued({ outcome: 'cooldown', retryAfterSeconds: 60, outboxId: null })),
    });
    const { service, client } = await build(store);
    expect(await service.sendWhatsAppOtp(request())).toEqual({ status: 'cooldown', retryAfterSeconds: 60 });
    expect(client.send).not.toHaveBeenCalled();
  });

  it.each([
    ['rate_limited_destination_hour'],
    ['rate_limited_destination_day'],
    ['rate_limited_ip_hour'],
  ] as const)('refuses %s without contacting the provider', async (outcome) => {
    const store = storeStub({
      issueOtpChallenge: vi.fn(async () => issued({ outcome, challengeId: null, outboxId: null })),
    });
    const { service, client } = await build(store);
    expect(await service.sendWhatsAppOtp(request())).toEqual({ status: 'rate_limited', reason: outcome });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('does not send twice when the message was already claimed', async () => {
    const store = storeStub({ beginOtpDelivery: vi.fn(async () => false) });
    const { service, client } = await build(store);
    expect(await service.sendWhatsAppOtp(request())).toEqual({ status: 'delivery_failed', challengeId: CHALLENGE });
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe('delivery failure is always terminal for the message', () => {
  // The clear code is gone once the send returns, so no later attempt could deliver this row. Every
  // failure mode must therefore settle `failed`, never `queued`.
  const FAILURES = [
    ['4xx', 'provider_status_400'],
    ['5xx', 'provider_status_500'],
    ['429', 'provider_status_429'],
    ['timeout', 'provider_timeout'],
    ['unreachable', 'provider_unreachable'],
  ] as const;

  it.each(FAILURES)('Waabek %s settles the outbox as failed and never consumes the challenge', async (_label, errorType) => {
    const store = storeStub();
    const { service } = await build(
      store,
      vi.fn(async () => ({ status: 'failed' as const, errorType })) as unknown as SendMock,
    );

    const result = await service.sendWhatsAppOtp(request());

    expect(result).toEqual({ status: 'delivery_failed', challengeId: CHALLENGE });
    expect(store.settleOtpDelivery).toHaveBeenCalledWith({
      outboxId: OUTBOX,
      status: 'failed',
      providerMessageId: null,
      errorType,
    });
    // The challenge is untouched: nothing verified it, so it stays unconsumed and usable by a resend.
    expect(store.verifyOtpChallenge).not.toHaveBeenCalled();
  });

  it.each(FAILURES)('Waabek %s never puts the outbox row back into queued', async (_label, errorType) => {
    const store = storeStub();
    const { service } = await build(
      store,
      vi.fn(async () => ({ status: 'failed' as const, errorType })) as unknown as SendMock,
    );
    await service.sendWhatsAppOtp(request());

    const calls = (store.settleOtpDelivery as unknown as { mock: { calls: [{ status: string }][] } }).mock.calls;
    expect(calls.map((call) => call[0]?.status)).toEqual(['failed']);
    expect(JSON.stringify(calls)).not.toContain('queued');
  });

  it('cannot express a requeue at all', () => {
    const source = readFileSync(new URL('../src/auth/otp/otp.service.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // No 'queued' literal and no retry scheduling survive in the executable code.
    expect(code).not.toContain("'queued'");
    expect(code).not.toContain('retryAt');
    expect(code).not.toContain('retryable');
  });
});

describe('the clear code never escapes the process', () => {
  it('reaches the provider but nothing else', async () => {
    const store = storeStub();
    const { service, client } = await build(store);
    await service.sendWhatsAppOtp(request());

    const code = /(\d{6})/.exec(String(client.send.mock.calls[0]?.[1]))?.[1] as string;
    expect(code).toMatch(/^[0-9]{6}$/);

    // Everything that crossed the database boundary, in full.
    const toDatabase = JSON.stringify([
      (store.issueOtpChallenge as unknown as { mock: { calls: unknown[] } }).mock.calls,
      (store.beginOtpDelivery as unknown as { mock: { calls: unknown[] } }).mock.calls,
      (store.settleOtpDelivery as unknown as { mock: { calls: unknown[] } }).mock.calls,
    ]);
    expect(toDatabase).not.toContain(code);
  });

  it('is absent from logs on both the success and the failure path', async () => {
    for (const send of [
      defaultSend(),
      vi.fn(async () => ({ status: 'failed' as const, errorType: 'provider_timeout' })) as unknown as SendMock,
    ]) {
      const lines: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => void lines.push(a.join(' ')));
      const log = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')));
      const { service, client } = await build(storeStub(), send);
      await service.sendWhatsAppOtp(request());
      const code = /(\d{6})/.exec(String(client.send.mock.calls[0]?.[1]))?.[1] as string;
      warn.mockRestore();
      log.mockRestore();
      expect(lines.join('\n')).not.toContain(code);
    }
  });

  it('never touches a queue: the service imports no producer or Redis client', () => {
    const source = readFileSync(new URL('../src/auth/otp/otp.service.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/bullmq|ioredis|createProducer|enqueue/i);
  });

  it('is not returned to the caller on any path', async () => {
    const { service, client } = await build(storeStub());
    const result = await service.sendWhatsAppOtp(request());
    const code = /(\d{6})/.exec(String(client.send.mock.calls[0]?.[1]))?.[1] as string;
    expect(JSON.stringify(result)).not.toContain(code);
  });
});

describe('verifying an OTP', () => {
  it('sends the digest, not the code', async () => {
    const store = storeStub();
    const { service } = await build(store);
    await service.verify(CHALLENGE, '012345');
    const [, digest] = (store.verifyOtpChallenge as unknown as { mock: { calls: [string, Buffer][] } }).mock.calls[0] as [string, Buffer];
    expect(digest).toEqual(new OtpPepper(PEPPER).digest('012345'));
    expect(digest.toString('utf8')).not.toContain('012345');
  });

  it.each(['verified', 'invalid', 'expired', 'consumed', 'too_many_attempts', 'not_found'] as const)(
    'passes the %s outcome through unchanged',
    async (outcome) => {
      const store = storeStub({ verifyOtpChallenge: vi.fn(async () => outcome) });
      const { service } = await build(store);
      expect(await service.verify(CHALLENGE, '012345')).toBe(outcome);
    },
  );
});
