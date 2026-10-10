import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  ListingModerationHistoryResponse,
  ModerationActionsResponse,
  ModerationListingDetail,
  ModerationListingQueueResponse,
  ModerationReportDetail,
  ModerationReportQueueResponse,
} from '@repo/contracts';
import {
  readListingModerationHistory,
  readModerationListing,
  readModerationListings,
  readModerationReport,
  readModerationReportActions,
  readModerationReports,
  type ModerationResult,
} from '../server/bff';
import { currentCookieHeader } from '../server/current-staff';
import { ListingModerationForm, ReportResolutionForm } from './moderation-forms';
import { adminPath } from '../paths';

/**
 * The moderation console's screens (Phase 7-N).
 *
 * **Every one is a server component rendered *inside* `RequireStaff`.** That placement is the whole of the RSC
 * protection: a gate that refuses never invokes `children`, so a subtree a colleague may not see is never
 * rendered, never serialized and never streamed. Nothing here is hidden with CSS and nothing is filtered in
 * the browser.
 *
 * **They fetch nothing until they render**, because the reads live in the gated subtree rather than in the
 * page function — so a refused request performs no read at all.
 *
 * **Each read is gated twice more.** The API requires the key that read needs and the database re-applies the
 * same test, so the two trails — which need `moderation.action.read` rather than the report or catalogue key —
 * are **absent rather than empty** for a colleague who holds everything else. An empty "Moderation history"
 * heading would itself say there was something they could not see.
 *
 * **The controls are shipped only where they apply.** A report already decided ships no decision form; a
 * listing the caller may not moderate, or one they sell themselves, ships no action form. Words for a control
 * that is not on the screen are not in the payload, which is why each form's copy is assembled next to the
 * branch that renders it.
 *
 * **No account is ever named.** The contracts carry `isOwnReport`, `resolvedByMe` and `isOwnAction` and no
 * account identifier at all, so there is nothing in this file that could render who reported something, who
 * sells it or which colleague decided it — only whether it was the reader.
 *
 * **Every state is a state, not an absence.** Empty queue, unreadable answer, ended session, a row that is not
 * this caller's to see, and a decision already made each have their own rendering.
 */

type Translate = Awaited<ReturnType<typeof getTranslations<'Moderation'>>>;

/** A timestamp shown to the minute, in the value the API sent. No zone arithmetic happens here. */
function minute(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

async function refusal(
  result: ModerationResult<unknown>,
  t: Translate,
): Promise<React.ReactElement | null> {
  if (result.kind === 'ok') return null;
  const shell = await getTranslations('Console');
  if (result.kind === 'unauthenticated') {
    return <Notice title={shell('signedOutTitle')} body={shell('signedOutBody')} />;
  }
  if (result.kind === 'notFound') return <Notice title={t('notFoundTitle')} body={t('notFoundBody')} />;
  if (result.kind === 'invalid') return <Notice title={t('cursorTitle')} body={t('cursorBody')} />;
  return <Notice title={shell('unavailableTitle')} body={shell('unavailableBody')} />;
}

function Notice({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="mt-8 rounded-lg border border-hairline p-6" role="status">
      <p className="text-base font-medium text-ink-strong">{title}</p>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">{body}</p>
    </div>
  );
}

function Cell({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="text-ink-strong">{value}</dd>
    </div>
  );
}

function Badge({ label }: { readonly label: string }) {
  return (
    <span className="rounded-full border border-edge-strong px-2 py-0.5 text-xs font-medium text-ink-strong">
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The report queue                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

export async function ModerationReportQueue({
  cursor,
  status,
}: {
  readonly cursor: string | null;
  readonly status: string | null;
}) {
  const t = await getTranslations('Moderation');
  const result = await readModerationReports(
    { cursor, status },
    { cookieHeader: await currentCookieHeader() },
  );

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const page = (result as { kind: 'ok'; data: ModerationReportQueueResponse }).data;

  if (page.items.length === 0) {
    return <Notice title={t('reportsEmptyTitle')} body={t('reportsEmptyBody')} />;
  }

  return (
    <>
      <ul className="mt-6 space-y-3">
        {page.items.map((report) => (
          <li key={report.id} className="rounded-lg border border-hairline p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-medium text-ink-strong">
                  <Link
                    href={adminPath(`/moderation/reports/${report.id}`)}
                    className="underline underline-offset-4"
                  >
                    {report.subjectLabel ?? t(`subjectType.${report.subjectType}`)}
                  </Link>
                </p>
                <p className="mt-1 text-sm text-ink-muted">
                  {t(`subjectType.${report.subjectType}`)}
                  {' · '}
                  {t(`reason.${report.reasonCode}`)}
                </p>
              </div>
              <Badge label={t(`status.${report.status}`)} />
            </div>

            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-body">
              {/*
                Read, never ranked: the queue is oldest first, because the schema's priority column is text
                and ordering it would express nothing. It is shown so a colleague can judge for themselves.
              */}
              <Cell label={t('priorityLabel')} value={t(`priority.${report.priority}`)} />
              <Cell label={t('filedAt')} value={minute(report.createdAt)} />
              {report.actionCount > 0 && (
                <Cell label={t('actionsLabel')} value={String(report.actionCount)} />
              )}
            </dl>

            {report.isOwnReport && (
              <p role="status" className="mt-3 text-sm text-ink-muted">
                {t('ownReportHint')}
              </p>
            )}
          </li>
        ))}
      </ul>
      {page.nextCursor !== null && (
        <p className="mt-6 text-sm">
          <Link
            href={`/moderation/reports?cursor=${encodeURIComponent(page.nextCursor)}${
              status === null ? '' : `&status=${encodeURIComponent(status)}`
            }`}
            className="underline underline-offset-4"
          >
            {t('nextPage')}
          </Link>
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One report                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export async function ModerationReportDetailView({ reportId }: { readonly reportId: string }) {
  const t = await getTranslations('Moderation');
  const cookieHeader = await currentCookieHeader();
  const result = await readModerationReport(reportId, { cookieHeader });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const report = (result as { kind: 'ok'; data: ModerationReportDetail }).data;

  const isFinal = report.status === 'actioned' || report.status === 'dismissed' || report.status === 'duplicate';
  const failureLabels = {
    notFound: t('failedNotFound'),
    alreadyFinal: t('failedAlreadyFinal'),
    ownReport: t('failedOwnReport'),
    invalid: t('failedInvalid'),
    signedOut: t('failedSignedOut'),
    unavailable: t('failedGeneric'),
  };

  return (
    <>
      <section
        aria-labelledby="report-subject"
        className="mt-6 rounded-lg border border-hairline p-4"
      >
        <h2 id="report-subject" className="text-lg font-medium text-ink-strong">
          {report.subjectLabel ?? t(`subjectType.${report.subjectType}`)}
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Badge label={t(`status.${report.status}`)} />
          <span className="text-sm text-ink-muted">{t(`subjectType.${report.subjectType}`)}</span>
          <span className="text-sm text-ink-muted">{t(`reason.${report.reasonCode}`)}</span>
          <span className="text-sm text-ink-muted">{t(`priority.${report.priority}`)}</span>
        </div>

        <dl aria-label={t('reportFacts')} className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-body">
          <Cell label={t('filedAt')} value={minute(report.createdAt)} />
          {report.resolvedAt !== null && (
            <Cell label={t('decidedAt')} value={minute(report.resolvedAt)} />
          )}
          {report.resolution !== null && (
            <Cell label={t('decisionLabel')} value={t(`status.${report.resolution}`)} />
          )}
        </dl>

        {/*
          The subject, where the repository can resolve one. For the six types it cannot — a message, a
          review, a person — the console says so rather than rendering an empty summary: no staff read path
          exists for them, which is a limit of the repository rather than of this screen.
        */}
        {report.subjectIsResolvable ? (
          <div className="mt-4 border-t border-hairline pt-4">
            <p className="text-xs text-ink-muted">{t('subjectLabel')}</p>
            {report.subjectStatus !== null && (
              <p className="mt-1 text-sm text-ink-strong">
                {t('subjectStatusLabel')}: {t(`listingStatus.${report.subjectStatus}`)}
              </p>
            )}
            {report.subjectType === 'listing' && report.subjectSlug !== null && (
              <p className="mt-2 text-sm">
                <Link
                  href={adminPath(`/catalog/${encodeURIComponent(report.subjectSlug)}`)}
                  className="underline underline-offset-4"
                  prefetch={false}
                >
                  {t('openSubject')}
                </Link>
              </p>
            )}
          </div>
        ) : (
          <p role="status" className="mt-4 text-sm text-ink-muted">
            {t('subjectUnavailable')}
          </p>
        )}

        {report.isOwnReport && (
          <p role="status" className="mt-4 text-sm font-medium text-ink-strong">
            {t('ownReportHint')}
          </p>
        )}
      </section>

      {report.details !== null && (
        <section aria-labelledby="report-details" className="mt-8">
          <h2 id="report-details" className="text-lg font-medium text-ink-strong">
            {t('detailsHeading')}
          </h2>
          <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-ink-strong">{report.details}</p>
        </section>
      )}

      {report.resolutionNote !== null && (
        <section aria-labelledby="report-note" className="mt-8">
          <h2 id="report-note" className="text-lg font-medium text-ink-strong">
            {t('noteHeading')}
          </h2>
          <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-ink-strong">
            {report.resolutionNote}
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {report.resolvedByMe ? t('decidedByYou') : t('decidedByColleague')}
          </p>
        </section>
      )}

      {/* A separate read on a different permission: absent entirely for a caller the API refuses. */}
      <ReportActions reportId={report.id} />

      {isFinal ? (
        <p role="status" className="mt-8 max-w-prose text-sm text-ink-muted">
          {t('alreadyDecidedHint')}
        </p>
      ) : report.isOwnReport ? null : (
        <ReportResolutionForm
          reportId={report.id}
          copy={{
            ...failureLabels,
            heading: t('decideHeading'),
            hint: t('decideHint'),
            statusLabel: t('decideStatusLabel'),
            statuses: {
              triaged: t('status.triaged'),
              actioned: t('status.actioned'),
              dismissed: t('status.dismissed'),
              duplicate: t('status.duplicate'),
            },
            noteLabel: t('decideNoteLabel'),
            noteHint: t('decideNoteHint'),
            noteRequired: t('decideNoteRequired'),
            duplicateLabel: t('decideDuplicateLabel'),
            duplicateHint: t('decideDuplicateHint'),
            duplicateRequired: t('decideDuplicateRequired'),
            submit: t('decideSubmit'),
            working: t('working'),
            confirm: t('decideConfirm'),
            cancel: t('cancel'),
            question: t('decideQuestion'),
          }}
        />
      )}
    </>
  );
}

/**
 * The moderation actions citing one report.
 *
 * Its own read, on `moderation.action.read`. A caller the API refuses gets `notFound`, and this renders
 * **no heading at all** rather than an empty section that would say there was something they could not see.
 */
async function ReportActions({ reportId }: { readonly reportId: string }) {
  const t = await getTranslations('Moderation');
  const result = await readModerationReportActions(reportId, {
    cookieHeader: await currentCookieHeader(),
  });
  if (result.kind !== 'ok') return null;
  const page = (result as { kind: 'ok'; data: ModerationActionsResponse }).data;
  if (page.items.length === 0) return null;

  return (
    <section aria-labelledby="report-actions" className="mt-8">
      <h2 id="report-actions" className="text-lg font-medium text-ink-strong">
        {t('actionsHeading')}
      </h2>
      <ul className="mt-4 space-y-3">
        {page.items.map((action) => (
          <li key={action.id} className="rounded-lg border border-hairline p-4">
            <p className="text-xs font-medium text-ink-muted">
              {t(`action.${action.action}`)} · {minute(action.createdAt)} ·{' '}
              {action.isOwnAction ? t('byYou') : t('byColleague')}
            </p>
            <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-ink-strong">{action.reason}</p>
            {action.notes !== null && (
              <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-ink-body">{action.notes}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The listing queue                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

export async function ModerationListingQueue({ cursor }: { readonly cursor: string | null }) {
  const t = await getTranslations('Moderation');
  const result = await readModerationListings({ cursor }, { cookieHeader: await currentCookieHeader() });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const page = (result as { kind: 'ok'; data: ModerationListingQueueResponse }).data;

  if (page.items.length === 0) {
    return <Notice title={t('listingsEmptyTitle')} body={t('listingsEmptyBody')} />;
  }

  return (
    <>
      <ul className="mt-6 space-y-3">
        {page.items.map((listing) => (
          <li key={listing.id} className="rounded-lg border border-hairline p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-medium text-ink-strong">
                  <Link href={adminPath(`/catalog/${listing.id}`)} className="underline underline-offset-4">
                    {listing.title}
                  </Link>
                </p>
                <p className="mt-1 font-mono text-xs text-ink-muted">{listing.slug}</p>
              </div>
              <Badge label={t(`listingStatus.${listing.status}`)} />
            </div>

            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-body">
              <Cell label={t('createdAt')} value={minute(listing.createdAt)} />
              <Cell label={t('typeLabel')} value={listing.listingTypeCode} />
              {listing.priceMinor !== null && (
                <Cell label={t('priceLabel')} value={`${listing.priceMinor} ${listing.currencyCode}`} />
              )}
              {listing.reportCount > 0 && (
                <Cell label={t('openReportsLabel')} value={String(listing.reportCount)} />
              )}
            </dl>

            {listing.isOwnListing && (
              <p role="status" className="mt-3 text-sm text-ink-muted">
                {t('ownListingHint')}
              </p>
            )}
          </li>
        ))}
      </ul>
      {page.nextCursor !== null && (
        <p className="mt-6 text-sm">
          <Link
            href={adminPath(`/catalog?cursor=${encodeURIComponent(page.nextCursor)}`)}
            className="underline underline-offset-4"
          >
            {t('nextPage')}
          </Link>
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One listing                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export async function ModerationListingDetailView({ listingId }: { readonly listingId: string }) {
  const t = await getTranslations('Moderation');
  const cookieHeader = await currentCookieHeader();
  const result = await readModerationListing(listingId, { cookieHeader });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const listing = (result as { kind: 'ok'; data: ModerationListingDetail }).data;

  return (
    <>
      <section aria-labelledby="listing-title" className="mt-6 rounded-lg border border-hairline p-4">
        <h2 id="listing-title" className="text-lg font-medium text-ink-strong">
          {listing.title}
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Badge label={t(`listingStatus.${listing.status}`)} />
          <span className="font-mono text-xs text-ink-muted">{listing.slug}</span>
        </div>

        <dl aria-label={t('listingFacts')} className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-body">
          <Cell label={t('typeLabel')} value={listing.listingTypeCode} />
          {listing.priceMinor !== null && (
            <Cell label={t('priceLabel')} value={`${listing.priceMinor} ${listing.currencyCode}`} />
          )}
          {listing.city !== null && <Cell label={t('cityLabel')} value={listing.city} />}
          {/* The storefront's public name and slug — never its account. */}
          {listing.sellerDisplayName !== null && (
            <Cell label={t('sellerLabel')} value={listing.sellerDisplayName} />
          )}
          <Cell label={t('createdAt')} value={minute(listing.createdAt)} />
          {listing.approvedAt !== null && (
            <Cell label={t('approvedAt')} value={minute(listing.approvedAt)} />
          )}
          {listing.openReportCount > 0 && (
            <Cell label={t('openReportsLabel')} value={String(listing.openReportCount)} />
          )}
        </dl>

        <div className="mt-4 border-t border-hairline pt-4">
          <p className="text-xs text-ink-muted">{t('descriptionLabel')}</p>
          <p
            lang={listing.contentLanguage}
            className="mt-1 max-w-prose whitespace-pre-line text-sm text-ink-strong"
          >
            {listing.description}
          </p>
        </div>

        {listing.isOwnListing && (
          <p role="status" className="mt-4 text-sm font-medium text-ink-strong">
            {t('ownListingHint')}
          </p>
        )}
      </section>

      {/* A separate read on a different permission: absent entirely for a caller the API refuses. */}
      <ListingHistory listingId={listing.id} />

      {/*
        The action form, only where it applies. `canModerate` is the database's own answer to whether this
        caller holds `catalog.listing.moderate` at aal2, and a listing the caller sells is one the writer
        would refuse — so neither ships the words for a control that cannot work.
      */}
      {listing.canModerate && !listing.isOwnListing && (
        <ListingModerationForm
          listingId={listing.id}
          copy={{
            heading: t('moderateHeading'),
            hint: t('moderateHint'),
            actionLabel: t('moderateActionLabel'),
            actions: {
              approve: t('listingAction.approve'),
              reject: t('listingAction.reject'),
              suspend: t('listingAction.suspend'),
              reinstate: t('listingAction.reinstate'),
              request_changes: t('listingAction.request_changes'),
            },
            reasonLabel: t('moderateReasonLabel'),
            reasonHint: t('moderateReasonHint'),
            reasonRequired: t('moderateReasonRequired'),
            reasonTooLong: t('moderateReasonTooLong'),
            submit: t('moderateSubmit'),
            working: t('working'),
            confirm: t('moderateConfirm'),
            cancel: t('cancel'),
            question: t('moderateQuestion'),
            notFound: t('failedNotFound'),
            noChange: t('failedNoChange'),
            notApplicable: t('failedNotApplicable'),
            ownListing: t('failedOwnListing'),
            invalid: t('failedInvalid'),
            signedOut: t('failedSignedOut'),
            unavailable: t('failedGeneric'),
          }}
        />
      )}
    </>
  );
}

async function ListingHistory({ listingId }: { readonly listingId: string }) {
  const t = await getTranslations('Moderation');
  const result = await readListingModerationHistory(listingId, {
    cookieHeader: await currentCookieHeader(),
  });
  if (result.kind !== 'ok') return null;
  const page = (result as { kind: 'ok'; data: ListingModerationHistoryResponse }).data;
  if (page.items.length === 0) return null;

  return (
    <section aria-labelledby="listing-history" className="mt-8">
      <h2 id="listing-history" className="text-lg font-medium text-ink-strong">
        {t('historyHeading')}
      </h2>
      <ul className="mt-4 space-y-3">
        {page.items.map((entry) => (
          <li key={entry.id} className="rounded-lg border border-hairline p-4">
            <p className="text-xs font-medium text-ink-muted">
              {t(`listingAction.${entry.action}`)} · {minute(entry.createdAt)} ·{' '}
              {entry.isOwnAction ? t('byYou') : t('byColleague')}
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              {t(`listingStatus.${entry.fromStatus}`)} → {t(`listingStatus.${entry.toStatus}`)}
            </p>
            <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-ink-strong">{entry.reason}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
