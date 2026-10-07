import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  REVIEW_STATUSES,
  type ReviewDetail,
  type ReviewModerationActionsResponse,
  type ReviewQueueResponse,
} from '@repo/contracts';
import {
  readReview,
  readReviewModerationActions,
  readReviewQueue,
  type ReviewModerationResult,
} from '../server/bff';
import { currentCookieHeader } from '../server/current-staff';
import { ReviewModerationForm } from './review-moderation-forms';
import { adminPath } from '../paths';

/**
 * The review moderation screens (Phase 7-P).
 *
 * **Both are server components rendered *inside* `RequireStaff`.** That placement is the whole of the RSC
 * protection: a gate that refuses never invokes `children`, so a subtree a colleague may not see is never
 * rendered, never serialized and never streamed. Nothing here is hidden with CSS and nothing is filtered in
 * the browser.
 *
 * **They fetch nothing until they render**, because the reads live in the gated subtree rather than in the
 * page function — so a refused request performs no read at all.
 *
 * **Each read is gated twice more, and the three keys are deliberately not held together.** The page's gate
 * checks the section's key; the API requires the key that read needs; the database re-applies the same test
 * with the key as a literal. So a colleague holding `reviews.review.read` and not `moderation.action.read`
 * gets the review and **no trail panel at all** — absent, not empty. An empty "History" heading would itself
 * say there was something they could not see.
 *
 * **The control is shipped only where it applies.** `canModerate` is a capability the API reports, so a
 * colleague who may read reviews and not rule on them is shipped neither the control nor the words for it. A
 * moderator who is the review's own buyer or seller receives the explanation instead of the control, because
 * `moderate_review` is going to refuse them and saying so beforehand is kinder than a failed request.
 *
 * **Nobody is named.** The contracts carry `moderatedByMe`, `isParty` and `isOwnAction` and no account at all,
 * so there is nothing in this file that could render the buyer who wrote a review or the colleague who ruled
 * on it — only whether it was the reader. The storefront is named by the slug its own public projection
 * publishes, and the order behind the review is never returned at all.
 *
 * **The reply is read-only, and the screen says so.** No writer for a reply's status exists in this
 * repository, so there is no hide or remove control beside the reply and no route behind one. That gap is
 * stated on the page rather than leaving a colleague hunting for a button that was never built.
 *
 * **Every state is a state, not an absence.** Empty queue, unreadable answer, ended session, a review that is
 * not this caller's to see, and a decision already recorded each have their own rendering.
 */

type Translate = Awaited<ReturnType<typeof getTranslations<'Reviews'>>>;

/** A timestamp shown to the minute, in the value the API sent. No zone arithmetic happens here. */
function minute(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

async function refusal(
  result: ReviewModerationResult<unknown>,
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

/** The rating, as its own number out of five. Not stars: a count reads the same in both directions. */
function rating(value: number, t: Translate): string {
  return t('ratingValue', { rating: value });
}

/* ------------------------------------------------------------------------------------------------ */
/* The queue                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export async function ReviewQueue({
  cursor,
  status,
}: {
  readonly cursor: string | null;
  readonly status: string | null;
}) {
  const t = await getTranslations('Reviews');
  const result = await readReviewQueue({ cursor, status }, { cookieHeader: await currentCookieHeader() });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const page = (result as { kind: 'ok'; data: ReviewQueueResponse }).data;

  if (page.items.length === 0) {
    return <Notice title={t('queueEmptyTitle')} body={t('queueEmptyBody')} />;
  }

  const filter = status === null ? '' : `&status=${encodeURIComponent(status)}`;

  return (
    <>
      <ul className="mt-6 space-y-3">
        {page.items.map((review) => (
          <li key={review.id} className="rounded-lg border border-neutral-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-medium text-neutral-900">
                  <Link href={adminPath(`/reviews/${review.id}`)} className="underline underline-offset-4">
                    {review.title ?? t('untitled')}
                  </Link>
                </p>
                <p className="mt-1 text-sm text-neutral-600">
                  {t('aboutStorefront', { storefront: review.sellerDisplayName })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge label={rating(review.rating, t)} />
                <Badge label={t(`status.${review.status}`)} />
                {review.autoHiddenReason !== null && <Badge label={t('autoHiddenBadge')} />}
                {review.isModerated && <Badge label={t('moderatedBadge')} />}
              </div>
            </div>

            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
              <Cell label={t('storefrontLabel')} value={review.sellerSlug} />
              <Cell
                label={t('bodyLabel')}
                value={review.hasBody ? t('bodyPresent') : t('bodyAbsent')}
              />
              <Cell
                label={t('replyLabel')}
                value={
                  review.hasReply && review.replyStatus !== null
                    ? t(`status.${review.replyStatus}`)
                    : t('replyAbsent')
                }
              />
              <Cell label={t('writtenLabel')} value={minute(review.createdAt)} />
            </dl>

            {/*
              Said on the row rather than discovered at the end of a decision: nobody moderates a review they
              are a party to, and the reader is the only account this row can describe.
            */}
            {review.isParty && (
              <p role="status" className="mt-3 text-sm text-neutral-600">
                {t('isPartyHint')}
              </p>
            )}
            {review.moderatedByMe && (
              <p className="mt-3 text-sm text-neutral-600">{t('moderatedByMeHint')}</p>
            )}
          </li>
        ))}
      </ul>
      {page.nextCursor !== null && (
        <NextPage
          href={adminPath(`/reviews?cursor=${encodeURIComponent(page.nextCursor)}${filter}`)}
          label={t('nextPage')}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One review                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export async function ReviewDetailView({ reviewId }: { readonly reviewId: string }) {
  const t = await getTranslations('Reviews');
  const result = await readReview(reviewId, { cookieHeader: await currentCookieHeader() });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const review = (result as { kind: 'ok'; data: ReviewDetail }).data;

  return (
    <section aria-labelledby="review-title" className="mt-6">
      <h2 id="review-title" className="text-lg font-medium text-neutral-900">
        {review.title ?? t('untitled')}
      </h2>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge label={rating(review.rating, t)} />
        <Badge label={t(`status.${review.status}`)} />
      </div>
      <p className="mt-2 text-sm text-neutral-600">
        <Link
          href={adminPath(`/sellers/storefront/${review.sellerSlug}`)}
          className="underline underline-offset-4"
        >
          {review.sellerDisplayName}
        </Link>
      </p>

      {review.body !== null && (
        <p className="mt-4 max-w-prose whitespace-pre-line text-neutral-800">{review.body}</p>
      )}

      <dl
        aria-label={t('reviewFacts')}
        className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3"
      >
        <Cell label={t('storefrontLabel')} value={review.sellerSlug} />
        <Cell label={t('storefrontStatusLabel')} value={review.sellerStatus} />
        <Cell label={t('writtenLabel')} value={minute(review.createdAt)} />
        <Cell label={t('updatedLabel')} value={minute(review.updatedAt)} />
        {review.moderatedAt !== null && (
          <Cell label={t('moderatedAtLabel')} value={minute(review.moderatedAt)} />
        )}
      </dl>

      {review.autoHiddenReason !== null && (
        <div className="mt-4 rounded-lg border border-neutral-200 p-4">
          <p className="text-xs text-neutral-600">{t('autoHiddenLabel')}</p>
          <p className="mt-1 max-w-prose text-sm text-neutral-900">{review.autoHiddenReason}</p>
        </div>
      )}

      {review.moderationReason !== null && (
        <div className="mt-4 rounded-lg border border-neutral-200 p-4">
          <p className="text-xs text-neutral-600">{t('moderationReasonLabel')}</p>
          <p className="mt-1 max-w-prose text-sm text-neutral-900">{review.moderationReason}</p>
          {review.moderatedByMe && (
            <p className="mt-2 text-xs text-neutral-600">{t('moderatedByMeHint')}</p>
          )}
        </div>
      )}

      {/*
        Why the automatic reassessment would hide this review. Shown so a colleague publishing it can see what
        they are overriding — and a decision, once recorded, is final against that automation.
      */}
      {review.publicationBlock !== null && (
        <p role="status" className="mt-4 max-w-prose text-sm text-neutral-600">
          {t(`publicationBlock.${review.publicationBlock}`)}
        </p>
      )}

      {/* The seller's answer, read so the whole exchange can be judged — and read-only, because nothing in
          this repository writes a reply's status. */}
      {review.replyBody !== null && (
        <section aria-labelledby="review-reply" className="mt-6 rounded-lg border border-neutral-200 p-4">
          <h3 id="review-reply" className="text-base font-medium text-neutral-900">
            {t('replyHeading')}
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {review.replyStatus !== null && <Badge label={t(`status.${review.replyStatus}`)} />}
          </div>
          <p className="mt-3 max-w-prose whitespace-pre-line text-neutral-800">{review.replyBody}</p>
          {review.replyModerationReason !== null && (
            <p className="mt-3 text-sm text-neutral-600">{review.replyModerationReason}</p>
          )}
          {review.replyCreatedAt !== null && (
            <p className="mt-3 text-xs text-neutral-600">
              {t('replyWritten', { when: minute(review.replyCreatedAt) })}
            </p>
          )}
          <p className="mt-3 max-w-prose text-sm text-neutral-600">{t('replyReadOnlyNote')}</p>
        </section>
      )}

      {/*
        The control, or the reason there is none. `canModerate` is the API's own capability, so a colleague
        holding only the read key is shipped neither the control nor its words; a party to the review is told
        why instead, because the writer is going to refuse them.

        All four statuses are offered from all four, because `moderate_review` imposes no matrix, and
        re-recording the current one re-affirms it with a fresh reason.
      */}
      {!review.canModerate ? null : review.isParty ? (
        <p role="status" className="mt-6 max-w-prose text-sm text-neutral-600">
          {t('isPartyNote')}
        </p>
      ) : (
        <ReviewModerationForm
          reviewId={review.id}
          currentStatus={review.status}
          copy={{
            heading: t('decisionHeading'),
            intro: t('decisionIntro'),
            statusLabel: t('decisionStatusLabel'),
            reasonLabel: t('reasonLabel'),
            reasonHint: t('reasonHint'),
            submit: t('decisionSubmit'),
            confirmPublish: t('confirmPublish'),
            confirmHide: t('confirmHide'),
            confirmRemove: t('confirmRemove'),
            confirmPending: t('confirmPending'),
            cancel: t('cancel'),
            working: t('working'),
            failed: t('failed'),
            conflict: t('conflict'),
            isParty: t('isPartyRefusal'),
            signedOut: t('signedOut'),
            targets: REVIEW_STATUSES.map((value) => ({ value, label: t(`status.${value}`) })),
          }}
        />
      )}

      <ReviewModerationTrail reviewId={review.id} />

      {/* The gap that remains, said on the page rather than left to be discovered. */}
      <p className="mt-6 max-w-prose text-sm text-neutral-600">{t('replyGapNote')}</p>
    </section>
  );
}

/**
 * The moderation trail of one review.
 *
 * Gated on `moderation.action.read`, which is 0027's own key and neither review key — so for a colleague who
 * does not hold it this renders **nothing at all**, heading included. An empty heading would say there was
 * something there.
 */
async function ReviewModerationTrail({ reviewId }: { readonly reviewId: string }) {
  const t = await getTranslations('Reviews');
  const result = await readReviewModerationActions(reviewId, {
    cookieHeader: await currentCookieHeader(),
  });
  if (result.kind !== 'ok') return null;
  const { items } = (result as { kind: 'ok'; data: ReviewModerationActionsResponse }).data;
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="review-history" className="mt-8">
      <h3 id="review-history" className="text-base font-medium text-neutral-900">
        {t('historyHeading')}
      </h3>
      <ul className="mt-3 space-y-3">
        {items.map((action) => (
          <li key={action.id} className="rounded-lg border border-neutral-200 p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge label={t(`action.${action.action}`)} />
              <span className="text-xs text-neutral-600">{minute(action.createdAt)}</span>
            </div>
            <p className="mt-2 max-w-prose text-neutral-900">{action.reason}</p>
            {action.notes !== null && (
              <p className="mt-2 max-w-prose text-neutral-700">{action.notes}</p>
            )}
            {action.isOwnAction && (
              <p className="mt-2 text-xs text-neutral-600">{t('ownActionHint')}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
