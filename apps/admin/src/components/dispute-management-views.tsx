import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  DISPUTE_RESOLUTIONS,
  type DisputeDetail,
  type DisputeMessagesResponse,
  type DisputeQueueResponse,
} from '@repo/contracts';
import {
  readDispute,
  readDisputeMessages,
  readDisputes,
  type DisputeManagementResult,
} from '../server/bff';
import { currentCookieHeader } from '../server/current-staff';
import { DisputeMessageForm, DisputeResolutionForm } from './dispute-management-forms';

/**
 * The dispute management screens (Phase 7-R).
 *
 * **Both are server components rendered *inside* `RequireStaff`.** That placement is the whole of the RSC
 * protection: a gate that refuses never invokes `children`, so a subtree a colleague may not see is never
 * rendered, never serialized and never streamed. Nothing here is hidden with CSS and nothing is filtered in the
 * browser.
 *
 * **They fetch nothing until they render**, because the reads live in the gated subtree rather than in the page
 * function — so a refused request performs no read at all. That matters more here than on most sections: a
 * Moderator is deliberately granted neither dispute key, so a good part of the console's staff is refused.
 *
 * ---------------------------------------------------------------------------------------------------
 * **A REFUND RESOLUTION RECORDS A DECISION AND MOVES NO MONEY, AND THESE SCREENS SAY SO.**
 *
 * The notice appears in three places, because a colleague who believed they had just paid somebody would be
 * wrong in a way that matters: on the detail beside a recorded refund decision, inside the resolution control
 * whenever a refund resolution is selected, and in the standing note at the foot of the page.
 * ---------------------------------------------------------------------------------------------------
 *
 * **The controls are shipped only where they apply.** `canManage` is a capability the API reports, so a
 * colleague who may read disputes and not act on them is shipped neither control nor the words for either. A
 * colleague who is the dispute's own buyer or seller is shipped the explanation instead of the resolution
 * control, because the writer will refuse them.
 *
 * **Nobody is named.** The contracts carry `isParty`, `resolvedByMe`, `openedByRole`, `authorRole` and
 * `isOwnMessage`, and no account at all — so there is nothing in this file that could render the buyer, the
 * seller, the opener or the colleague who ruled. The storefront is named by its own slug and the order by its
 * own reference.
 *
 * **Money is rendered from strings.** Every amount arrives as a decimal string of minor units and is split into
 * major and minor parts by string arithmetic, never by `Number` or `parseInt`: a 64-bit minor amount does not
 * fit a JavaScript number, and rendering is exactly where that would go wrong unnoticed.
 *
 * **Three things are stated as deferred rather than left as gaps**: no evidence panel, because nothing attaches
 * evidence; only two dispute states are reachable, so no other filter is offered; and nothing assigns a dispute
 * or changes its due date.
 *
 * **Every state is a state, not an absence.** Empty queue, unreadable answer, ended session, a dispute that is
 * not this caller's to see, a closed thread, and a dispute already resolved each have their own rendering.
 */

type Translate = Awaited<ReturnType<typeof getTranslations<'Disputes'>>>;

/** A timestamp shown to the minute, in the value the API sent. No zone arithmetic happens here. */
function minute(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

/**
 * An amount, from a decimal string of minor units, by string arithmetic only.
 *
 * Never `Number`, never `parseInt`, never division: a 64-bit minor amount exceeds what a JavaScript number can
 * hold exactly, and rendering is precisely where that loss would pass unnoticed. Two decimal places, which is
 * what every currency this platform has enabled uses; a currency with a different minor unit would need its
 * `decimal_places` carried here, and none is in play.
 */
function amount(minor: string, currencyCode: string): string {
  const digits = /^[0-9]+$/.test(minor) ? minor : '0';
  const padded = digits.padStart(3, '0');
  const major = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  return `${major}.${fraction} ${currencyCode}`;
}

async function refusal(
  result: DisputeManagementResult<unknown>,
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
    <div className="mt-8 rounded-lg border border-neutral-200 p-6" role="status">
      <p className="text-base font-medium text-neutral-900">{title}</p>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{body}</p>
    </div>
  );
}

function Cell({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-600">{label}</dt>
      <dd className="text-neutral-900">{value}</dd>
    </div>
  );
}

function Badge({ label }: { readonly label: string }) {
  return (
    <span className="rounded-full border border-neutral-400 px-2 py-0.5 text-xs font-medium text-neutral-800">
      {label}
    </span>
  );
}

function NextPage({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <p className="mt-6 text-sm">
      <Link href={href} className="underline underline-offset-4">
        {label}
      </Link>
    </p>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The queue                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export async function DisputeQueue({
  cursor,
  status,
}: {
  readonly cursor: string | null;
  readonly status: string | null;
}) {
  const t = await getTranslations('Disputes');
  const result = await readDisputes({ cursor, status }, { cookieHeader: await currentCookieHeader() });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const page = (result as { kind: 'ok'; data: DisputeQueueResponse }).data;

  if (page.items.length === 0) {
    return <Notice title={t('queueEmptyTitle')} body={t('queueEmptyBody')} />;
  }

  const filter = status === null ? '' : `&status=${encodeURIComponent(status)}`;

  return (
    <>
      <ul className="mt-6 space-y-3">
        {page.items.map((dispute) => (
          <li key={dispute.id} className="rounded-lg border border-neutral-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-medium text-neutral-900">
                  <Link href={`/disputes/${dispute.id}`} className="underline underline-offset-4">
                    {t(`reason.${dispute.reasonCode}`)}
                  </Link>
                </p>
                <p className="mt-1 text-sm text-neutral-600">
                  {t('onOrder', { orderNumber: dispute.orderNumber })}
                  {dispute.sellerDisplayName !== null
                    ? ` · ${dispute.sellerDisplayName}`
                    : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge label={t(`status.${dispute.status}`)} />
                {dispute.resolution !== null && (
                  <Badge label={t(`resolution.${dispute.resolution}`)} />
                )}
              </div>
            </div>

            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
              {dispute.claimAmountMinor !== null && (
                <Cell
                  label={t('claimLabel')}
                  value={amount(dispute.claimAmountMinor, dispute.currencyCode)}
                />
              )}
              <Cell label={t('orderStatusLabel')} value={dispute.orderStatus} />
              <Cell label={t('messagesLabel')} value={String(dispute.messageCount)} />
              <Cell
                label={t('detailsLabel')}
                value={dispute.hasDetails ? t('detailsPresent') : t('detailsAbsent')}
              />
              <Cell label={t('openedLabel')} value={minute(dispute.createdAt)} />
              {dispute.dueAt !== null && (
                <Cell label={t('dueLabel')} value={minute(dispute.dueAt)} />
              )}
            </dl>

            {/*
              Said on the row rather than discovered at the end of a decision: nobody rules on a dispute they
              are a party to, and the reader is the only account this row can describe.
            */}
            {dispute.isParty && (
              <p role="status" className="mt-3 text-sm text-neutral-600">
                {t('isPartyHint')}
              </p>
            )}
            {dispute.resolvedByMe && (
              <p className="mt-3 text-sm text-neutral-600">{t('resolvedByMeHint')}</p>
            )}
          </li>
        ))}
      </ul>
      {page.nextCursor !== null && (
        <NextPage
          href={`/disputes?cursor=${encodeURIComponent(page.nextCursor)}${filter}`}
          label={t('nextPage')}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One dispute                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export async function DisputeDetailView({ disputeId }: { readonly disputeId: string }) {
  const t = await getTranslations('Disputes');
  const result = await readDispute(disputeId, { cookieHeader: await currentCookieHeader() });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const dispute = (result as { kind: 'ok'; data: DisputeDetail }).data;

  const isResolved = dispute.status === 'resolved';
  const decidedRefund =
    dispute.resolution === 'refund_buyer' || dispute.resolution === 'partial_refund';

  return (
    <section aria-labelledby="dispute-reason" className="mt-6">
      <h2 id="dispute-reason" className="text-lg font-medium text-neutral-900">
        {t(`reason.${dispute.reasonCode}`)}
      </h2>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge label={t(`status.${dispute.status}`)} />
        <Badge label={t(`openedBy.${dispute.openedByRole}`)} />
        {dispute.resolution !== null && <Badge label={t(`resolution.${dispute.resolution}`)} />}
      </div>
      <p className="mt-2 text-sm text-neutral-600">
        {t('onOrder', { orderNumber: dispute.orderNumber })}
        {dispute.sellerSlug !== null && (
          <>
            {' · '}
            <Link
              href={`/sellers/storefront/${dispute.sellerSlug}`}
              className="underline underline-offset-4"
            >
              {dispute.sellerDisplayName ?? dispute.sellerSlug}
            </Link>
          </>
        )}
      </p>

      {dispute.details !== null && (
        <p className="mt-4 max-w-prose whitespace-pre-line text-neutral-800">{dispute.details}</p>
      )}

      <dl
        aria-label={t('disputeFacts')}
        className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3"
      >
        {dispute.claimAmountMinor !== null && (
          <Cell
            label={t('claimLabel')}
            value={amount(dispute.claimAmountMinor, dispute.currencyCode)}
          />
        )}
        <Cell
          label={t('orderTotalLabel')}
          value={amount(dispute.orderGrandTotalMinor, dispute.currencyCode)}
        />
        <Cell label={t('orderStatusLabel')} value={dispute.orderStatus} />
        <Cell label={t('orderTypeLabel')} value={t(`orderType.${dispute.orderType}`)} />
        {/* The snapshot the dispute took, which a resolution restores. */}
        <Cell label={t('statusBeforeLabel')} value={dispute.orderStatusBefore} />
        {dispute.orderPlacedAt !== null && (
          <Cell label={t('orderPlacedLabel')} value={minute(dispute.orderPlacedAt)} />
        )}
        <Cell label={t('openedLabel')} value={minute(dispute.createdAt)} />
        {dispute.dueAt !== null && <Cell label={t('dueLabel')} value={minute(dispute.dueAt)} />}
        {dispute.resolvedAt !== null && (
          <Cell label={t('resolvedAtLabel')} value={minute(dispute.resolvedAt)} />
        )}
      </dl>

      {/* The recorded decision, and — for a refund — what it did and did not do. */}
      {dispute.resolution !== null && (
        <div className="mt-4 rounded-lg border border-neutral-300 p-4">
          <p className="text-base font-medium text-neutral-900">{t('decisionHeading')}</p>
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
            <Cell label={t('decisionLabel')} value={t(`resolution.${dispute.resolution}`)} />
            {dispute.resolutionAmountMinor !== null && (
              <Cell
                label={t('decidedAmountLabel')}
                value={amount(dispute.resolutionAmountMinor, dispute.currencyCode)}
              />
            )}
          </dl>
          {dispute.resolutionNote !== null && (
            <p className="mt-3 max-w-prose text-sm text-neutral-900">{dispute.resolutionNote}</p>
          )}
          {dispute.resolvedByMe && (
            <p className="mt-2 text-xs text-neutral-600">{t('resolvedByMeHint')}</p>
          )}
          {/*
            The boundary, beside the recorded decision: a refund was decided, and no money has moved. Somebody
            reading this record later needs to know that as much as the colleague who wrote it.
          */}
          {decidedRefund && (
            <p role="status" className="mt-3 max-w-prose text-sm text-neutral-900">
              {t('refundDecidedNotMoved')}
            </p>
          )}
        </div>
      )}

      <DisputeThread disputeId={dispute.id} />

      {/*
        The two controls, or the reason there are none. `canManage` is the API's own capability, so a colleague
        holding only the read key is shipped neither control nor its words; a party is told why instead of being
        shown a resolution control the writer will refuse.
      */}
      {!dispute.canManage ? (
        <p role="status" className="mt-8 max-w-prose text-sm text-neutral-600">
          {t('readOnlyNote')}
        </p>
      ) : isResolved ? (
        <p role="status" className="mt-8 max-w-prose text-sm text-neutral-600">
          {t('closedNote')}
        </p>
      ) : (
        <>
          <DisputeMessageForm
            disputeId={dispute.id}
            copy={{
              heading: t('messageHeading'),
              intro: t('messageIntro'),
              bodyLabel: t('messageBodyLabel'),
              internalLabel: t('internalLabel'),
              internalHint: t('internalHint'),
              submit: t('messageSubmit'),
              confirmVisible: t('confirmVisible'),
              confirmInternal: t('confirmInternal'),
              cancel: t('cancel'),
              working: t('working'),
              failed: t('failed'),
              conflict: t('conflict'),
              closed: t('threadClosed'),
              isParty: t('internalIsParty'),
              signedOut: t('signedOut'),
            }}
          />

          {dispute.isParty ? (
            <p role="status" className="mt-8 max-w-prose text-sm text-neutral-600">
              {t('isPartyNote')}
            </p>
          ) : (
            <DisputeResolutionForm
              disputeId={dispute.id}
              copy={{
                heading: t('resolveHeading'),
                intro: t('resolveIntro'),
                noMoneyNotice: t('noMoneyNotice'),
                resolutionLabel: t('resolutionLabel'),
                reasonLabel: t('reasonLabel'),
                reasonHint: t('reasonHint'),
                amountLabel: t('amountLabel'),
                amountHint: t('amountHint'),
                amountInvalid: t('amountInvalid'),
                submit: t('resolveSubmit'),
                confirmRefund: t('confirmRefund'),
                confirmRelease: t('confirmRelease'),
                confirmNoAction: t('confirmNoAction'),
                cancel: t('cancel'),
                working: t('working'),
                failed: t('failed'),
                conflict: t('conflict'),
                alreadyResolved: t('alreadyResolved'),
                isParty: t('isPartyRefusal'),
                amountNotAllowed: t('amountNotAllowed'),
                signedOut: t('signedOut'),
                currencyCode: dispute.currencyCode,
                resolutions: DISPUTE_RESOLUTIONS.map((value) => ({
                  value,
                  label: t(`resolution.${value}`),
                })),
              }}
            />
          )}
        </>
      )}

      <p className="mt-6 text-sm">
        <Link href="/disputes" className="underline underline-offset-4">
          {t('backToQueue')}
        </Link>
      </p>

      {/* The standing notes: what a resolution does, and the three things this section cannot do yet. */}
      <p className="mt-6 max-w-prose text-sm text-neutral-600">{t('boundaryNote')}</p>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('deferredNote')}</p>
    </section>
  );
}

/**
 * The thread on one dispute.
 *
 * A refusal renders nothing at all rather than an empty heading. An internal note is marked, because a
 * colleague needs to know which of these two people can read what they are looking at.
 */
async function DisputeThread({ disputeId }: { readonly disputeId: string }) {
  const t = await getTranslations('Disputes');
  const result = await readDisputeMessages(disputeId, {
    cookieHeader: await currentCookieHeader(),
  });
  if (result.kind !== 'ok') return null;
  const { items } = (result as { kind: 'ok'; data: DisputeMessagesResponse }).data;
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="dispute-thread" className="mt-8">
      <h3 id="dispute-thread" className="text-base font-medium text-neutral-900">
        {t('threadHeading')}
      </h3>
      <ul className="mt-3 space-y-3">
        {items.map((message) => (
          <li
            key={message.id}
            className={`rounded-lg border p-4 text-sm ${
              message.isInternal ? 'border-neutral-400 bg-neutral-50' : 'border-neutral-200'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                <Badge label={t(`author.${message.authorRole}`)} />
                {message.isInternal && <Badge label={t('internalBadge')} />}
              </div>
              <span className="text-xs text-neutral-600">{minute(message.createdAt)}</span>
            </div>
            <p className="mt-2 max-w-prose whitespace-pre-line text-neutral-900">{message.body}</p>
            {message.isOwnMessage && (
              <p className="mt-2 text-xs text-neutral-600">{t('ownMessageHint')}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
