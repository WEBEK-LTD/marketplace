import 'server-only';
import {
  JOB_NAME_PATTERN,
  JOB_RUN_STATUSES,
  JobRunDetailResponseSchema,
  JobRunPageResponseSchema,
  OutboxResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  ScheduleProblemsResponseSchema,
  ScheduledJobCatalogueResponseSchema,
  type JobRunDetail,
  type JobRunPageResponse,
  type OutboxResponse,
  type ScheduleProblemsResponse,
  type ScheduledJobCatalogueResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * Platform job runs and outbox health, on the admin origin (Phase 7-Q).
 *
 * ---------------------------------------------------------------------------------------------------
 * **FIVE READS, AND NOTHING ELSE. THIS MODULE HAS NO WRITE PATH AT ALL.**
 *
 * Every other BFF module on this origin carries an `acceptWrite`, a `callWrite` and a `writeOutcome` — the
 * same-origin check, the rebuilt body, the forwarded refusal. **None of them is here.** There is no
 * `POST` helper, no route handler, no origin check (nothing to protect, because nothing is submitted), and no
 * `Request` parameter anywhere in the file.
 *
 * That is the shape the absence of a writer takes at this layer. The workers own every write to a job run and
 * to an outbox event, so there is no retry, no cancel, no requeue and no replay upstream to call — and a
 * request arriving at this origin asking for one has nothing here to reach.
 * ---------------------------------------------------------------------------------------------------
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission key and no assurance
 * level appears in anything built here. The API resolves all of it from the session, and the database
 * re-applies the permission test with `platform.job.read` as a literal.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered page, and a field the contract does not name cannot reach a browser even if the API sent one —
 * which is the third wall in front of the two things that must never appear on this screen: the raw
 * PostgreSQL error message the job runner stores in a free-form details object, and any identifier belonging
 * to an outbox event or the row it is about.
 *
 * **Cursors stay opaque.** A cursor is passed along as text and never parsed or reconstructed here.
 *
 * **Nothing here logs.** A job failure names the function that failed and a dead letter names what is stuck;
 * the way to keep either out of a log is to have no log line that could take one.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/admin',
  code: 'SERVICE_UNAVAILABLE',
} as const;

function problemResponse(status: number, title: string, code: string, detail: string): Response {
  return new Response(JSON.stringify({ ...PROBLEM, status, title, code, detail }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

/**
 * Kept for the shape every module on this origin shares, and unused on purpose.
 *
 * It exists so the absence above is visible rather than accidental: this is where a refusal builder would be
 * needed if a control were ever added here, and there is none because there is no control.
 */
void problemResponse;

export interface PlatformOperationsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such run, or a caller without `platform.job.read`. The console
 * does not try to tell those apart, because the API deliberately does not — and on a key only Admin and Super
 * Admin hold, a distinguishable refusal would tell a Moderator that this section has something in it.
 */
export type PlatformOperationsResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** base64url, which is the whole of what a cursor can be. Refused here rather than forwarded. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: string | undefined | null): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/**
 * Builds a query string from what the caller passed, dropping what it did not.
 *
 * The status filter is checked against 0007's own four and the job name against the column's own format:
 * neither an unknown status nor a malformed name would match anything upstream, and dropping them here keeps a
 * mistyped bookmark showing the whole list instead of an empty one or an error.
 */
function query(input: {
  readonly cursor?: string | null;
  readonly limit?: string | null;
  readonly status?: string | null;
  readonly jobName?: string | null;
}): string {
  const params = new URLSearchParams();
  if (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)) params.set('limit', input.limit);
  if (
    typeof input.status === 'string' &&
    (JOB_RUN_STATUSES as readonly string[]).includes(input.status)
  ) {
    params.set('status', input.status);
  }
  if (
    typeof input.jobName === 'string' &&
    input.jobName.length <= 200 &&
    JOB_NAME_PATTERN.test(input.jobName)
  ) {
    params.set('jobName', input.jobName);
  }
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    // Passed along as text. This layer does not know what a cursor contains and must not learn.
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

async function read<T>(
  path: string,
  options: PlatformOperationsOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<PlatformOperationsResult<T>> {
  const accessToken = readAdminAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return { kind: 'unavailable' };
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    if (upstream.status === 401) return { kind: 'unauthenticated' };
    if (upstream.status === 404) return { kind: 'notFound' };
    if (upstream.status === 400) return { kind: 'invalid' };
    return { kind: 'unavailable' };
  }

  try {
    const parsed = parse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* The five reads                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/** One page of job runs, newest first. */
export async function readJobRuns(
  input: {
    readonly cursor?: string | null;
    readonly limit?: string | null;
    readonly status?: string | null;
    readonly jobName?: string | null;
  } = {},
  options: PlatformOperationsOptions = {},
): Promise<PlatformOperationsResult<JobRunPageResponse>> {
  return await read(`/v1/admin/platform/job-runs${query(input)}`, options, (body) =>
    JobRunPageResponseSchema.safeParse(body),
  );
}

/**
 * One job run.
 *
 * A malformed id is `notFound` here rather than a validation failure: the value came from the address somebody
 * typed, and the honest answer to a made-up address is that there is nothing at it.
 */
export async function readJobRun(
  runId: string | undefined,
  options: PlatformOperationsOptions = {},
): Promise<PlatformOperationsResult<JobRunDetail>> {
  const id = identifier(runId ?? null);
  if (id === null) return { kind: 'notFound' };
  const result = await read(
    `/v1/admin/platform/job-runs/${encodeURIComponent(id)}`,
    options,
    (body) => JobRunDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.run } : result;
}

/** Every contracted job, with the facts of its most recent run. */
export async function readScheduledJobs(
  options: PlatformOperationsOptions = {},
): Promise<PlatformOperationsResult<ScheduledJobCatalogueResponse>> {
  return await read('/v1/admin/platform/scheduled-jobs', options, (body) =>
    ScheduledJobCatalogueResponseSchema.safeParse(body),
  );
}

/** Where the real schedule and the contract disagree. Empty is the good answer. */
export async function readScheduleProblems(
  options: PlatformOperationsOptions = {},
): Promise<PlatformOperationsResult<ScheduleProblemsResponse>> {
  return await read('/v1/admin/platform/schedule-problems', options, (body) =>
    ScheduleProblemsResponseSchema.safeParse(body),
  );
}

/**
 * The outbox as counts and ages, with its dead-letter groups.
 *
 * One upstream read carrying both halves, validated against the one schema that describes both — so a body
 * missing either half, or carrying a field neither names, is an outage rather than a half-rendered panel.
 */
export async function readOutbox(
  options: PlatformOperationsOptions = {},
): Promise<PlatformOperationsResult<OutboxResponse>> {
  return await read('/v1/admin/platform/outbox', options, (body) =>
    OutboxResponseSchema.safeParse(body),
  );
}
