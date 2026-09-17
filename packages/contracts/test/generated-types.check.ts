// Compile-time proof that the generated client types match the Zod contract types (TOOL-2).
import type { HealthResponse, ProblemDetails, ReadinessResponse } from '../src/index.js';
import type { apiClient } from '../src/index.js';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const healthMatches: Exact<apiClient.HealthResponse, HealthResponse> = true;
export const readinessMatches: Exact<apiClient.ReadinessResponse, ReadinessResponse> = true;
// Zod's optional `errors` also accepts an explicit `undefined` (exactOptionalPropertyTypes);
// the generated interface does not. Apart from that the two types are identical.
type WithoutExplicitUndefined<T> = { [K in keyof T]: Exclude<T[K], undefined> };
export const problemMatches: Exact<apiClient.ProblemDetails, WithoutExplicitUndefined<ProblemDetails>> = true;
export const problemIsNotExactlyEqual: Exact<apiClient.ProblemDetails, ProblemDetails> = false;

export type HealthCallResult = Awaited<ReturnType<typeof apiClient.getHealth>>;
export const okBranch: Extract<HealthCallResult, { status: 200 }>['data'] extends HealthResponse ? true : false = true;
export const errorBranch: Extract<HealthCallResult, { status: 500 }>['data'] extends ProblemDetails ? true : false = true;
