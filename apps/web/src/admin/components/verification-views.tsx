import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { VerificationQueueResponse, VerificationReview } from '@repo/contracts';
import { readVerificationDetail, readVerificationQueue, type ReviewResult } from '../server/bff';
import { currentCookieHeader } from '../server/current-staff';
import { VerificationDecisionForm } from './verification-decision-form';
import { VerificationDocumentButton } from './verification-document-button';
import { adminPath } from '../paths';

/**
 * The reviewer's two screens (Phase 7-G).
 *
 * **Both of these are server components rendered *inside* `RequireStaff`.** That placement is the whole
 * of the RSC protection: a gate that refuses never invokes `children`, so a subtree that is not allowed
 * is never rendered, never serialized and never streamed. Nothing here is hidden with CSS and nothing is
 * filtered in the browser — content a person may not see does not exist in their response.
 *
 * **They fetch nothing until they render.** The reads below live in the gated subtree rather than in the
 * page function, so a refused request performs no read at all. That is also why the section heading is
 * rendered by the page around them: a reviewer who is allowed in still sees a titled page when a read
 * fails, instead of a bare error where a screen should be.
 *
 * **Every state is a state, not an absence.** Empty queue, unreadable answer, ended session, no such
 * application and a decided application each have their own rendering, because a reviewer who cannot
 * tell "nothing is waiting" from "we could not ask" will eventually act on the wrong one.
 *
 * **No document is inlined.** A document's bytes never pass through this console: what is rendered is
 * metadata plus a button that asks the server, at the moment of the click, for a short-lived
 * authorization to open that one object. No path, no bucket and no credential is in the markup — the
 * button knows two identifiers, both of which name rows.
 */

/* ------------------------------------------------------------------------------------------------ */
/* The queue                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export async function VerificationQueue({
  status,
  cursor,
}: {
  readonly status: string | null;
  readonly cursor: string | null;
}) {
  const t = await getTranslations('Verification');
  const result = await readVerificationQueue(
    { status, cursor },
    { cookieHeader: await currentCookieHeader() },
  );

  const failure = await refusal(result, t);
  if (failure !== null) return failure;
  const page = (result as { kind: 'ok'; data: VerificationQueueResponse }).data;

  return (
    <>
      <nav aria-label={t('filterLabel')} className="mt-6 flex flex-wrap gap-2">
        <FilterLink current={status} value={null} label={t('filter.waiting')} />
        <FilterLink current={status} value="submitted" label={t('status.submitted')} />
        <FilterLink current={status} value="under_review" label={t('status.under_review')} />
        <FilterLink current={status} value="approved" label={t('status.approved')} />
        <FilterLink current={status} value="rejected" label={t('status.rejected')} />
        <FilterLink current={status} value="expired" label={t('status.expired')} />
      </nav>

      {page.items.length === 0 ? (
        <div className="mt-8 rounded-lg border border-neutral-200 p-6" role="status">
          <p className="text-base font-medium text-neutral-900">{t('emptyTitle')}</p>
          <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('emptyBody')}</p>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {page.items.map((item) => (
            <li key={item.id} className="rounded-lg border border-neutral-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-base font-medium text-neutral-900">{item.sellerDisplayName}</p>
                  <p dir="ltr" className="mt-1 break-all font-mono text-xs text-neutral-600">
                    {item.sellerSlug}
                  </p>
                </div>
                <StatusBadge status={item.status} label={t(`status.${item.status}`)} />
              </div>

              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
                <div>
                  <dt className="text-xs text-neutral-600">{t('submittedOn')}</dt>
                  <dd>
                    <time dateTime={item.submittedAt}>{item.submittedAt.slice(0, 10)}</time>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-600">{t('documents')}</dt>
                  <dd>{item.documentCount}</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-600">{t('contacts')}</dt>
                  <dd>
                    {t(item.emailVerified ? 'emailVerified' : 'emailUnverified')} ·{' '}
                    {t(item.phoneVerified ? 'phoneVerified' : 'phoneUnverified')}
                  </dd>
                </div>
              </dl>

              <Link
                href={adminPath(`/sellers/verification/${item.id}`)}
                className="mt-4 inline-block rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900 underline-offset-4"
              >
                {t('open')}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {page.nextCursor !== null && (
        <Link
          href={queueHref(status, page.nextCursor)}
          className="mt-6 inline-block rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900"
        >
          {t('next')}
        </Link>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One submission                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

export async function VerificationDetail({ verificationId }: { readonly verificationId: string }) {
  const t = await getTranslations('Verification');
  const result = await readVerificationDetail(verificationId, {
    cookieHeader: await currentCookieHeader(),
  });

  const failure = await refusal(result, t);
  if (failure !== null) return failure;
  const verification = (result as { kind: 'ok'; data: VerificationReview }).data;
  const seller = verification.seller;

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">{seller.displayName}</h2>
        <StatusBadge status={verification.status} label={t(`status.${verification.status}`)} />
      </div>

      <section aria-labelledby="verification-identity" className="mt-6">
        <h3 id="verification-identity" className="text-base font-medium text-neutral-900">
          {t('identity')}
        </h3>
        <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Field label={t('storefront')} value={seller.slug} monospace />
          <Field label={t('legalName')} value={seller.legalName} empty={t('notProvided')} />
          <Field
            label={t('location')}
            value={[seller.city, seller.governorate, seller.countryCode].filter(Boolean).join(', ')}
            empty={t('notProvided')}
          />
          <Field label={t('contactEmail')} value={seller.contactEmail} empty={t('notProvided')} />
          <Field label={t('contactPhone')} value={seller.contactPhone} empty={t('notProvided')} monospace />
          <Field label={t('storefrontStatus')} value={seller.status} />
          <Field label={t('storefrontVerification')} value={seller.verificationStatus} />
          <Field label={t('sellerSince')} value={seller.createdAt.slice(0, 10)} />
        </dl>
      </section>

      <section aria-labelledby="verification-application" className="mt-8">
        <h3 id="verification-application" className="text-base font-medium text-neutral-900">
          {t('application')}
        </h3>
        <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Field
            label={t('submittedOn')}
            value={verification.submittedAt === null ? null : verification.submittedAt.slice(0, 10)}
            empty={t('notProvided')}
          />
          <Field label={t('startedOn')} value={verification.createdAt.slice(0, 10)} />
          <Field
            label={t('contacts')}
            value={`${t(verification.emailVerified ? 'emailVerified' : 'emailUnverified')} · ${t(
              verification.phoneVerified ? 'phoneVerified' : 'phoneUnverified',
            )}`}
          />
          {verification.reviewedAt !== null && (
            <Field label={t('reviewedOn')} value={verification.reviewedAt.slice(0, 10)} />
          )}
          {verification.decisionReason !== null && (
            <Field label={t('decisionReason')} value={verification.decisionReason} wide />
          )}
        </dl>
      </section>

      <section aria-labelledby="verification-evidence" className="mt-8">
        <h3 id="verification-evidence" className="text-base font-medium text-neutral-900">
          {t('documents')}
        </h3>
        {verification.documents.length === 0 ? (
          <p className="mt-3 max-w-prose text-sm text-neutral-600" role="status">
            {t('documentsEmpty')}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {verification.documents.map((document) => (
              <li key={document.id} className="rounded-lg border border-neutral-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-neutral-900">
                      {t(`documentType.${document.documentType}`)}
                    </p>
                    <p dir="ltr" className="mt-1 break-all text-xs text-neutral-600">
                      {document.originalFilename ?? t('notProvided')}
                    </p>
                  </div>
                  <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-700">
                    {t(`documentStatus.${document.status}`)}
                  </span>
                </div>
                <p className="mt-2 text-xs text-neutral-600">
                  <time dateTime={document.uploadedAt}>{document.uploadedAt.slice(0, 10)}</time>
                  {document.contentType !== null && <span className="ms-3">{document.contentType}</span>}
                </p>
                <VerificationDocumentButton
                  verificationId={verification.id}
                  documentId={document.id}
                  labels={{
                    view: t('viewDocument'),
                    working: t('working'),
                    failed: t('viewFailed'),
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="verification-decision" className="mt-8">
        <h3 id="verification-decision" className="text-base font-medium text-neutral-900">
          {t('decision')}
        </h3>
        {verification.decidable ? (
          <VerificationDecisionForm
            verificationId={verification.id}
            canApprove={verification.emailVerified && verification.phoneVerified}
            labels={{
              approve: t('approve'),
              reject: t('reject'),
              reasonLabel: t('reasonLabel'),
              reasonHelpApprove: t('reasonHelpApprove'),
              reasonHelpReject: t('reasonHelpReject'),
              reasonRequired: t('reasonRequired'),
              confirmApprove: t('confirmApprove'),
              confirmReject: t('confirmReject'),
              confirm: t('confirm'),
              cancel: t('cancel'),
              working: t('working'),
              contactsBlocked: t('contactsBlocked'),
              failedConflict: t('failedConflict'),
              failedContacts: t('failedContacts'),
              failedGeneric: t('failedGeneric'),
            }}
          />
        ) : (
          <p className="mt-3 max-w-prose text-sm text-neutral-600" role="status">
            {t('alreadyDecided')}
          </p>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Shared pieces                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The three ways a read can end without data.
 *
 * `notFound` is the API's one neutral answer for "no such application", "it is a draft" and "you may
 * not review it", and this console does not attempt to tell them apart, because the API deliberately
 * does not either.
 */
async function refusal(
  result: ReviewResult<unknown>,
  t: Awaited<ReturnType<typeof getTranslations<'Verification'>>>,
): Promise<React.ReactElement | null> {
  if (result.kind === 'ok') return null;
  const console = await getTranslations('Console');
  if (result.kind === 'unauthenticated') {
    return <Notice title={console('signedOutTitle')} body={console('signedOutBody')} />;
  }
  if (result.kind === 'notFound') {
    return <Notice title={t('notFoundTitle')} body={t('notFoundBody')} />;
  }
  return <Notice title={console('unavailableTitle')} body={console('unavailableBody')} />;
}

function Notice({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="mt-8 rounded-lg border border-neutral-200 p-6" role="status">
      <p className="text-base font-medium text-neutral-900">{title}</p>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{body}</p>
    </div>
  );
}

function Field({
  label,
  value,
  empty,
  monospace = false,
  wide = false,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly empty?: string;
  readonly monospace?: boolean;
  readonly wide?: boolean;
}) {
  const shown = value === null || value === '' ? (empty ?? '—') : value;
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs text-neutral-600">{label}</dt>
      <dd
        {...(monospace ? { dir: 'ltr' as const } : {})}
        className={
          monospace
            ? 'mt-0.5 break-all font-mono text-sm text-neutral-900'
            : 'mt-0.5 text-sm text-neutral-900'
        }
      >
        {shown}
      </dd>
    </div>
  );
}

/** A status, shown as a word and a border rather than as a colour alone. */
function StatusBadge({ status, label }: { readonly status: string; readonly label: string }) {
  const tone =
    status === 'approved'
      ? 'border-neutral-900 text-neutral-900'
      : status === 'rejected' || status === 'expired'
        ? 'border-neutral-400 text-neutral-600'
        : 'border-neutral-600 text-neutral-800';
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
  );
}

function queueHref(status: string | null, cursor: string | null): string {
  const query = new URLSearchParams();
  if (status !== null) query.set('status', status);
  if (cursor !== null) query.set('cursor', cursor);
  const suffix = query.toString();
  return suffix === '' ? '/sellers/verification' : `/sellers/verification?${suffix}`;
}

function FilterLink({
  current,
  value,
  label,
}: {
  readonly current: string | null;
  readonly value: string | null;
  readonly label: string;
}) {
  const active = current === value;
  return (
    <Link
      href={queueHref(value, null)}
      {...(active ? { 'aria-current': 'page' as const } : {})}
      className={`rounded-md border px-3 py-1 text-sm ${
        active ? 'border-neutral-900 font-medium text-neutral-900' : 'border-neutral-300 text-neutral-700'
      }`}
    >
      {label}
    </Link>
  );
}
