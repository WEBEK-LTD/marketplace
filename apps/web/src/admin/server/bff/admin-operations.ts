import 'server-only';
import {
  ACCOUNT_STATUSES,
  AdminRoleCatalogueResponseSchema,
  AdminSecurityEventsResponseSchema,
  AdminSellerDetailResponseSchema,
  AdminSellerPageResponseSchema,
  AdminUserDetailResponseSchema,
  AdminUserPageResponseSchema,
  AdminUserRolesResponseSchema,
  AuditPageResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  RECOVERY_STATUSES,
  RecoveryCompletionRequestSchema,
  RecoveryCompletionResponseSchema,
  RecoveryDecisionRequestSchema,
  RecoveryDecisionResponseSchema,
  RecoveryEvidenceResponseSchema,
  RecoveryQueueResponseSchema,
  RecoveryRequestDetailResponseSchema,
  RecoveryReviewRequestSchema,
  RecoveryReviewResponseSchema,
  SELLER_STATUSES,
  SELLER_VERIFICATION_STATUSES,
  SESSION_TOKEN_HEADER,
  SellerStatusChangeRequestSchema,
  SellerStatusChangeResponseSchema,
  StaffGrantableRolesResponseSchema,
  StaffRoleGrantRequestSchema,
  StaffRoleRevokeRequestSchema,
  StaffRoleWriteResponseSchema,
  type AdminRoleCatalogueResponse,
  type AdminSecurityEventsResponse,
  type AdminSellerDetail,
  type AdminSellerPageResponse,
  type AdminUserDetail,
  type AdminUserPageResponse,
  type AdminUserRolesResponse,
  type AuditPageResponse,
  type StaffGrantableRolesResponse,
  type RecoveryEvidenceResponse,
  type RecoveryQueueResponse,
  type RecoveryRequestDetail,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAdminAccessToken } from './staff-session';

/**
 * Seller and user reads, role reads, recovery review and the audit trail, on the admin origin (Phase 7-O).
 *
 * Eleven reads a page performs before it renders, and four writes a colleague posts to. The rules are 7-F's,
 * 7-G's, 7-J's, 7-L's and 7-N's, applied to a surface where the subjects are people's accounts.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission key and no assurance
 * level appears in anything built here. The API resolves all of it from the session, and the database
 * re-applies the permission test with the key as a literal.
 *
 * **Bodies are rebuilt, never forwarded.** A review sends a note. A decision sends one of two words and a
 * reason. A completion sends one boolean. A screen that added a `reviewerUserId`, an `approverUserId`, a
 * `status`, a `holdUntil`, a `sessionsRevokedAt` or an `mfaResetAt` would have it dropped before the request
 * left this origin, and the API's strict schema would refuse it anyway. Two independent walls, neither
 * relying on the other.
 *
 * **There is no role write in this module, and there is no route for one.** `public.user_roles` is written by
 * nothing in this repository, and by owner decision that writer is deferred to its own increment after
 * Phase 7 — so a request arriving at this origin asking to grant a role has nothing here to reach.
 *
 * **The seller status write is the fourth.** Its body is rebuilt from two fields: where the storefront should
 * end up, and the reason a suspension requires. A `suspendedAt`, a `closedAt`, a `verificationStatus` or
 * anything naming a listing, an order or a payout is dropped here and refused upstream.
 *
 * **A storefront is named by slug and an account and a recovery request by their ids, in the route, never in
 * a body.** Each is checked here for shape, so a made-up address never becomes an upstream call.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered page, and a field the contract does not name cannot reach a browser even if the API sent one
 * — which is the third wall in front of a legal name, a phone number, a contact digest, an object path and
 * the old and new values of an audited row.
 *
 * **Cursors stay opaque.** A cursor is passed along as text and never parsed or reconstructed here.
 *
 * **Nothing here logs.** A recovery request is somebody locked out of their account and an audit row names
 * what they did; the way to keep either out of a log is to have no log line that could take one.
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

const UNAVAILABLE = (): Response =>
  problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
const SESSION_REQUIRED = (): Response =>
  problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
const VALIDATION_FAILED = (): Response =>
  problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');

/** The statuses the API may refuse a write with. Anything else becomes the generic outage. */
const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503]);

export interface AdminOperationsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such storefront, account or request, or a caller without the
 * key the operation needs. The console does not try to tell those apart, because the API deliberately does
 * not — and on these six keys, which are not held together, that is the whole protection.
 */
export type AdminOperationsResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** base64url, which is the whole of what a cursor can be. Refused here rather than forwarded. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;
const PG_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const RECORD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

function identifier(value: string | undefined | null): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function slug(value: string | undefined | null): string | null {
  return typeof value === 'string' && SLUG_PATTERN.test(value) ? value : null;
}

/**
 * Builds a query string from what the caller passed, dropping what it did not.
 *
 * Each status filter is checked against the vocabulary the database actually has rather than forwarded as
 * free text: an unknown value would match nothing upstream anyway, and dropping it here keeps a mistyped
 * bookmark showing the whole list instead of an empty one.
 */
function query(input: {
  readonly cursor?: string | null;
  readonly limit?: string | null;
  readonly status?: string | null;
  readonly statuses?: readonly string[];
  readonly verificationStatus?: string | null;
  readonly tableSchema?: string | null;
  readonly tableName?: string | null;
  readonly recordId?: string | null;
}): string {
  const params = new URLSearchParams();
  if (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)) params.set('limit', input.limit);
  if (
    typeof input.status === 'string' &&
    input.statuses !== undefined &&
    input.statuses.includes(input.status)
  ) {
    params.set('status', input.status);
  }
  if (
    typeof input.verificationStatus === 'string' &&
    (SELLER_VERIFICATION_STATUSES as readonly string[]).includes(input.verificationStatus)
  ) {
    params.set('verificationStatus', input.verificationStatus);
  }
  // The audit filters are names, so they are checked against the shape a name can have. A record is only
  // ever sent alongside the table it belongs to, which is the API's own rule too.
  const schema =
    typeof input.tableSchema === 'string' && PG_IDENTIFIER_PATTERN.test(input.tableSchema)
      ? input.tableSchema
      : null;
  const table =
    typeof input.tableName === 'string' && PG_IDENTIFIER_PATTERN.test(input.tableName)
      ? input.tableName
      : null;
  if (schema !== null && table !== null) {
    params.set('tableSchema', schema);
    params.set('tableName', table);
    if (typeof input.recordId === 'string' && RECORD_ID_PATTERN.test(input.recordId)) {
      params.set('recordId', input.recordId);
    }
  }
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    // Passed along as text. This layer does not know what a cursor contains and must not learn.
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

async function read<T>(
  path: string,
  options: AdminOperationsOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<AdminOperationsResult<T>> {
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
/* Storefronts                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export async function readAdminSellers(
  input: {
    readonly cursor?: string | null;
    readonly limit?: string | null;
    readonly status?: string | null;
    readonly verificationStatus?: string | null;
  } = {},
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<AdminSellerPageResponse>> {
  return await read(
    `/v1/admin/sellers${query({ ...input, statuses: SELLER_STATUSES })}`,
    options,
    (body) => AdminSellerPageResponseSchema.safeParse(body),
  );
}

/**
 * One storefront.
 *
 * A malformed slug is `notFound` here rather than a validation failure: the value came from the address
 * somebody typed, and the honest answer to a made-up address is that there is nothing at it.
 */
export async function readAdminSeller(
  value: string | undefined,
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<AdminSellerDetail>> {
  const handle = slug(value ?? null);
  if (handle === null) return { kind: 'notFound' };
  const result = await read(
    `/v1/admin/sellers/${encodeURIComponent(handle)}`,
    options,
    (body) => AdminSellerDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.seller } : result;
}

/* ------------------------------------------------------------------------------------------------ */
/* Accounts                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export async function readAdminUsers(
  input: {
    readonly cursor?: string | null;
    readonly limit?: string | null;
    readonly status?: string | null;
  } = {},
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<AdminUserPageResponse>> {
  return await read(
    `/v1/admin/users${query({ ...input, statuses: ACCOUNT_STATUSES })}`,
    options,
    (body) => AdminUserPageResponseSchema.safeParse(body),
  );
}

export async function readAdminUser(
  userId: string | undefined,
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<AdminUserDetail>> {
  const id = identifier(userId ?? null);
  if (id === null) return { kind: 'notFound' };
  const result = await read(
    `/v1/admin/users/${encodeURIComponent(id)}`,
    options,
    (body) => AdminUserDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.user } : result;
}

/**
 * What roles one account holds.
 *
 * A read and nothing more. There is no companion in this module that grants or revokes one, because no
 * authoritative writer for `user_roles` exists in this repository.
 */
export async function readAdminUserRoles(
  userId: string | undefined,
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<AdminUserRolesResponse>> {
  const id = identifier(userId ?? null);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/admin/users/${encodeURIComponent(id)}/roles`,
    options,
    (body) => AdminUserRolesResponseSchema.safeParse(body),
  );
}

export async function readAdminUserSecurityEvents(
  userId: string | undefined,
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<AdminSecurityEventsResponse>> {
  const id = identifier(userId ?? null);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/admin/users/${encodeURIComponent(id)}/security-events`,
    options,
    (body) => AdminSecurityEventsResponseSchema.safeParse(body),
  );
}

export async function readAdminRoleCatalogue(
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<AdminRoleCatalogueResponse>> {
  return await read('/v1/admin/roles', options, (body) =>
    AdminRoleCatalogueResponseSchema.safeParse(body),
  );
}

/**
 * The roles this caller may grant (0100).
 *
 * Behind `users.role.manage`, and the set is the database's own: this function asks for it and renders what
 * comes back. It never filters a catalogue, because a filter on this side would be a convention and the
 * boundary it stands for is a privilege boundary.
 */
export async function readStaffGrantableRoles(
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<StaffGrantableRolesResponse>> {
  return await read('/v1/admin/roles/grantable', options, (body) =>
    StaffGrantableRolesResponseSchema.safeParse(body),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Account recovery                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

export async function readRecoveryQueue(
  input: {
    readonly cursor?: string | null;
    readonly limit?: string | null;
    readonly status?: string | null;
  } = {},
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<RecoveryQueueResponse>> {
  return await read(
    `/v1/admin/recovery/requests${query({ ...input, statuses: RECOVERY_STATUSES })}`,
    options,
    (body) => RecoveryQueueResponseSchema.safeParse(body),
  );
}

export async function readRecoveryRequest(
  requestId: string | undefined,
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<RecoveryRequestDetail>> {
  const id = identifier(requestId ?? null);
  if (id === null) return { kind: 'notFound' };
  const result = await read(
    `/v1/admin/recovery/requests/${encodeURIComponent(id)}`,
    options,
    (body) => RecoveryRequestDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.request } : result;
}

export async function readRecoveryEvidence(
  requestId: string | undefined,
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<RecoveryEvidenceResponse>> {
  const id = identifier(requestId ?? null);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/admin/recovery/requests/${encodeURIComponent(id)}/evidence`,
    options,
    (body) => RecoveryEvidenceResponseSchema.safeParse(body),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The audit trail                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export async function readAdminAudit(
  input: {
    readonly cursor?: string | null;
    readonly limit?: string | null;
    readonly tableSchema?: string | null;
    readonly tableName?: string | null;
    readonly recordId?: string | null;
  } = {},
  options: AdminOperationsOptions = {},
): Promise<AdminOperationsResult<AuditPageResponse>> {
  return await read(`/v1/admin/audit${query(input)}`, options, (body) =>
    AuditPageResponseSchema.safeParse(body),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes — the three recovery steps, and nothing else                                               */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: AdminOperationsOptions,
): Promise<{ refusal: Response } | { accessToken: string; body: Record<string, unknown> }> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return {
      refusal: problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.'),
    };
  }

  const accessToken = readAdminAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return { refusal: SESSION_REQUIRED() };

  let body: unknown;
  try {
    const raw = await request.text();
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return { refusal: VALIDATION_FAILED() };
  }
  if (typeof body !== 'object' || body === null) return { refusal: VALIDATION_FAILED() };
  return { accessToken, body: body as Record<string, unknown> };
}

async function callWrite(
  path: string,
  accessToken: string,
  body: unknown,
  options: AdminOperationsOptions,
): Promise<Response | null> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    return await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

/**
 * Turns one upstream write response into the browser's.
 *
 * A recognised refusal is forwarded with the API's own problem body, so a screen can say "somebody else has
 * to decide this one" rather than a generic failure — which is exactly what the reviewer trying to approve
 * their own review needs to be told. Anything else becomes the generic 503, and success is the expected
 * status exactly, re-validated before a byte of it reaches a browser.
 */
async function writeOutcome<T>(
  upstream: Response | null,
  expected: number,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<Response> {
  if (upstream === null) return UNAVAILABLE();

  const text = await upstream.text();
  if (upstream.status !== expected) {
    if (!WRITE_PROBLEM_STATUSES.has(upstream.status)) return UNAVAILABLE();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return UNAVAILABLE();
  }
  const validated = parse(parsed);
  if (!validated.success) return UNAVAILABLE();

  return new Response(JSON.stringify(validated.data), {
    status: expected,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `POST /api/recovery/review` — record the identity review.
 *
 * The body is rebuilt from the contract's one field. A `reviewerUserId` or a `status` is dropped here and
 * would be refused upstream as well; the writer fixes the caller as the reviewer from their own session.
 */
export async function handleRecoveryReview(
  request: Request,
  options: AdminOperationsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const requestId = identifier(
    typeof accepted.body['requestId'] === 'string' ? accepted.body['requestId'] : null,
  );
  if (requestId === null) return VALIDATION_FAILED();

  const note = accepted.body['note'];
  const validated = RecoveryReviewRequestSchema.safeParse(
    typeof note === 'string' && note.trim() !== '' ? { note: note.trim() } : {},
  );
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/recovery/requests/${encodeURIComponent(requestId)}/review`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => RecoveryReviewResponseSchema.safeParse(body));
}

/**
 * `POST /api/recovery/decision` — the second approver's decision.
 *
 * The body is rebuilt from the contract's two fields. The decision is not validated against a list in this
 * file: the contract owns the writer's own two words, and the status the request lands on is the writer's
 * mapping rather than anything a browser sends. An `approverUserId` is dropped here.
 */
export async function handleRecoveryDecision(
  request: Request,
  options: AdminOperationsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const requestId = identifier(
    typeof accepted.body['requestId'] === 'string' ? accepted.body['requestId'] : null,
  );
  if (requestId === null) return VALIDATION_FAILED();

  const note = accepted.body['note'];
  const validated = RecoveryDecisionRequestSchema.safeParse({
    decision: accepted.body['decision'],
    ...(typeof note === 'string' && note.trim() !== '' ? { note: note.trim() } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/recovery/requests/${encodeURIComponent(requestId)}/decision`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => RecoveryDecisionResponseSchema.safeParse(body));
}

/**
 * `POST /api/recovery/completion` — finish a recovery.
 *
 * The body is rebuilt from the contract's one boolean. There is no `holdUntil`, no `sessionsRevokedAt` and
 * no `mfaResetAt` field: the writer computes and records all three, and a screen that sent one would have it
 * dropped here and refused upstream.
 */
export async function handleRecoveryCompletion(
  request: Request,
  options: AdminOperationsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const requestId = identifier(
    typeof accepted.body['requestId'] === 'string' ? accepted.body['requestId'] : null,
  );
  if (requestId === null) return VALIDATION_FAILED();

  const validated = RecoveryCompletionRequestSchema.safeParse({
    mfaWasReset: accepted.body['mfaWasReset'] === true,
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/recovery/requests/${encodeURIComponent(requestId)}/completion`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => RecoveryCompletionResponseSchema.safeParse(body));
}

/**
 * `POST /api/sellers/status` — change one storefront's account status.
 *
 * The body is rebuilt from the contract's two fields. The target status is not validated against a list in
 * this file: the contract owns 0009's four values, and **which pairs are legal is the database's** — so this
 * layer cannot express a transition rule and cannot get one wrong. A `suspendedAt`, a `closedAt`, a
 * `verificationStatus`, a `verifiedAt` or a field naming another domain is dropped before the request leaves
 * this origin, and the API's strict schema would refuse it as well.
 */
export async function handleSellerStatusChange(
  request: Request,
  options: AdminOperationsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const handle = slug(typeof accepted.body['slug'] === 'string' ? accepted.body['slug'] : null);
  if (handle === null) return VALIDATION_FAILED();

  const reason = accepted.body['reason'];
  const validated = SellerStatusChangeRequestSchema.safeParse({
    status: accepted.body['status'],
    ...(typeof reason === 'string' && reason.trim() !== '' ? { reason: reason.trim() } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/sellers/${encodeURIComponent(handle)}/status`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => SellerStatusChangeResponseSchema.safeParse(body));
}

/**
 * `POST /api/users/roles/grant` — grant a role, or reinstate one that was withdrawn (0100).
 *
 * The account is named in the body here because this origin's write routes take their target that way, and it
 * becomes a path segment upstream after being checked for shape. **Nothing else from the body travels**: the
 * role key, the reason and the optional expiry are validated against the contract and forwarded, and every
 * boundary that decides whether the grant is allowed is applied in the database.
 */
export async function handleStaffRoleGrant(
  request: Request,
  options: AdminOperationsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['userId'] === 'string' ? accepted.body['userId'] : null);
  if (id === null) return VALIDATION_FAILED();

  // An expiry is optional. An empty field from a form is "no expiry", not an invalid one; anything that is
  // present and not a string is refused rather than read as absent.
  const suppliedExpiry = accepted.body['expiresAt'];
  if (suppliedExpiry !== undefined && suppliedExpiry !== null && typeof suppliedExpiry !== 'string') {
    return VALIDATION_FAILED();
  }
  const expiresAt =
    typeof suppliedExpiry === 'string' && suppliedExpiry.trim() !== '' ? suppliedExpiry.trim() : null;

  const validated = StaffRoleGrantRequestSchema.safeParse({
    roleKey: accepted.body['roleKey'],
    reason: accepted.body['reason'],
    ...(expiresAt === null ? {} : { expiresAt }),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/users/${encodeURIComponent(id)}/roles`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => StaffRoleWriteResponseSchema.safeParse(body));
}

/**
 * `POST /api/users/roles/revoke` — withdraw a role (0100).
 *
 * A reason is required, as it is on the grant. The row is not deleted anywhere in this path: the upstream
 * writer records the withdrawal on it.
 */
export async function handleStaffRoleRevoke(
  request: Request,
  options: AdminOperationsOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(typeof accepted.body['userId'] === 'string' ? accepted.body['userId'] : null);
  if (id === null) return VALIDATION_FAILED();

  const validated = StaffRoleRevokeRequestSchema.safeParse({
    roleKey: accepted.body['roleKey'],
    reason: accepted.body['reason'],
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/users/${encodeURIComponent(id)}/roles/revoke`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => StaffRoleWriteResponseSchema.safeParse(body));
}
