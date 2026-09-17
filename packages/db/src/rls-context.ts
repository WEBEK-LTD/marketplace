import { SpanKind, SpanStatusCode, trace } from '@repo/telemetry';
import { sql, type Kysely, type Transaction } from 'kysely';

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Claims that the caller has already verified. This package never parses or verifies JWTs
 * (authentication is Phase 3); it only applies the given claims to the transaction.
 */
export interface RlsClaims {
  readonly sub: string;
  readonly [claim: string]: JsonValue;
}

export class InvalidClaimsError extends TypeError {
  constructor(reason: string) {
    super(`Invalid RLS claims: ${reason}`);
    this.name = 'InvalidClaimsError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (isPlainObject(value)) return Object.values(value).every(isJson);
  return false;
}

/** Serialises the claims for `request.jwt.claims`; the result is sent as a query parameter. */
export function serializeClaims(claims: RlsClaims): string {
  if (!isPlainObject(claims)) throw new InvalidClaimsError('claims must be a plain object');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new InvalidClaimsError('sub must be a non-empty string');
  if (!isJson(claims)) throw new InvalidClaimsError('claims must contain only JSON values');
  return JSON.stringify(claims);
}

/**
 * Runs `work` in one transaction as `authenticated` with the given claims, so RLS applies.
 * Both settings are transaction-local (`SET LOCAL ROLE`, `set_config(..., true)`): PostgreSQL restores
 * the session's role and claims when the transaction commits, rolls back or fails. All work that relies
 * on the context must use the provided transaction.
 */
export async function withRlsContext<DB, T>(
  db: Kysely<DB>,
  claims: RlsClaims,
  work: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  const serialized = serializeClaims(claims);
  // Explicit database span (O8-9): only db.system; never SQL text, parameters, claims or connection data.
  return trace.getTracer('db').startActiveSpan(
    'db.transaction',
    { kind: SpanKind.CLIENT, attributes: { 'db.system': 'postgresql' } },
    async (span) => {
      try {
        return await db.transaction().execute(async (trx) => {
          await sql`set local role authenticated`.execute(trx);
          await sql`select set_config('request.jwt.claims', ${serialized}, true)`.execute(trx);
          return work(trx);
        });
      } catch (error) {
        span.setAttribute('error.type', error instanceof Error ? error.name : typeof error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
