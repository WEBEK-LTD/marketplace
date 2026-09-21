import { Injectable, Logger } from '@nestjs/common';

/**
 * The Waabek WhatsApp delivery adapter.
 *
 * Waabek is the delivery layer and nothing more. It does not generate, store, verify or expire the
 * marketplace's OTP: that authority stays in this project, which is why this client calls the generic
 * send endpoint and not Waabek's own `/api/otp/send` or `/api/otp/verify`.
 *
 * Every Waabek call in this project goes through this class. Nothing else may `fetch` the provider.
 */

/**
 * Outcome of one delivery attempt.
 *
 * There is deliberately **no `retryable` flag**. A retry would need the clear code, which no longer
 * exists once this call returns: it is never stored, so nothing downstream could reconstruct it. Every
 * failure is therefore terminal for that message, and the person asks for a new code through the
 * approved resend flow. Re-adding a retry hint here would be the first step back towards a queued
 * outbox row that can never be delivered.
 */
export type WaabekOutcome =
  | { readonly status: 'sent'; readonly providerMessageId: string | null }
  | { readonly status: 'failed'; readonly errorType: string };

export interface WaabekConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Injectable for tests; defaults to the platform fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

@Injectable()
export class WaabekClient {
  private readonly logger = new Logger(WaabekClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(config: WaabekConfig) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new TypeError('Waabek base URL must be http or https.');
    }
    if (config.apiKey.trim() === '') throw new RangeError('Waabek API key must not be blank.');
    this.baseUrl = url.origin;
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  /** The one endpoint this project uses. */
  get sendUrl(): string {
    return `${this.baseUrl}/api/v1/send`;
  }

  /**
   * Sends one WhatsApp message.
   *
   * `message` contains the OTP, so it is never logged and never returned in an error. Nothing about the
   * body is echoed into the log line — only the outcome and, on failure, a coarse error type.
   */
  async send(to: string, message: string): Promise<WaabekOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.sendUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Server-side only. This header never leaves the API process.
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({ to, message }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // The status is recorded for diagnosis, but it changes nothing: every failure is terminal.
        this.logger.warn(`Waabek send rejected with status ${response.status}`);
        return { status: 'failed', errorType: `provider_status_${response.status}` };
      }

      return { status: 'sent', providerMessageId: await readMessageId(response) };
    } catch (error) {
      const errorType = (error as { name?: string })?.name === 'AbortError' ? 'provider_timeout' : 'provider_unreachable';
      // The message body is never included: it carries the code.
      this.logger.warn(`Waabek send failed (${errorType})`);
      return { status: 'failed', errorType };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pulls a provider message id out of the response if one is present.
 *
 * Tolerant on purpose: the id is only recorded for tracing, so an unexpected body shape must not turn a
 * successful send into a failure.
 */
async function readMessageId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const candidate =
      (body as { messageId?: unknown }).messageId ??
      (body as { id?: unknown }).id ??
      (body as { data?: { id?: unknown } }).data?.id;
    return typeof candidate === 'string' && candidate !== '' ? candidate : null;
  } catch {
    return null;
  }
}
