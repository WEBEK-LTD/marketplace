import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ListingAnalyticsResponse } from '@repo/contracts';
import { readListingAnalytics, type ListingAnalyticsResult } from '../server/bff';
import { currentCookieHeader } from '../server/current-staff';

/**
 * The listing analytics screen (0102).
 *
 * **A server component rendered *inside* `RequireStaff`.** That placement is the whole of the RSC protection: a
 * gate that refuses never invokes `children`, so a subtree a colleague may not see is never rendered, never
 * serialized and never streamed. Nothing here is hidden with CSS and nothing is filtered in the browser.
 *
 * It fetches nothing until it renders, because the read lives in the gated subtree rather than in the page
 * function — so a refused request performs no read at all. That matters here as much as on the platform
 * section: `analytics.listing.read` is held by Admin and Super Admin alone.
 *
 * ---------------------------------------------------------------------------------------------------
 * **THERE IS NO CONTROL IN THIS FILE, AND NO CLIENT COMPONENT BESIDE IT.**
 *
 * No re-run, no recompute, no backfill button, no export — no control of any kind. The rollup is a scheduled
 * job, and a day is corrected by running that job for it; a control here would post to a route that does not
 * exist. The page says so in words rather than leaving somebody hunting for a button.
 * ---------------------------------------------------------------------------------------------------
 *
 * **Two standing facts are stated on the page rather than inferred from the numbers.** Impressions and views are
 * not counted for a listing, because what counts as one has not been settled — so a reader does not wonder why
 * the columns are missing. And `favourites` and `shares` read zero until a control on the public site fires
 * them, which is a surfaces gap rather than a quiet month.
 *
 * **No verdict is rendered.** Counts are shown as counts. Nothing here computes a rate, a ratio or a
 * click-through, colours a number, or calls a listing popular: none of those has a definition in this
 * repository, and inventing one on a screen is inventing a KPI.
 *
 * **An empty page is a state, not an absence.** It is also what a colleague without the key receives, and the
 * copy covers both without telling them apart — the API deliberately does not, and a distinguishable refusal
 * would tell somebody without the key that this section has something in it.
 */

type Translate = Awaited<ReturnType<typeof getTranslations<'ListingAnalytics'>>>;

async function refusal(
  result: ListingAnalyticsResult,
  t: Translate,
): Promise<React.ReactElement | null> {
  if (result.kind === 'ok') return null;
  const shell = await getTranslations('Console');
  if (result.kind === 'unauthenticated') {
    return <Notice title={shell('signedOutTitle')} body={shell('signedOutBody')} />;
  }
  if (result.kind === 'invalid') return <Notice title={t('cursorTitle')} body={t('cursorBody')} />;
  return <Notice title={t('unavailableTitle')} body={t('unavailableBody')} />;
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

/** A timestamp to the minute. A rollup runs once a night; seconds would be noise. */
function minute(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

export async function ListingAnalyticsTable({
  cursor,
  days,
}: {
  readonly cursor: string | null;
  readonly days: string | null;
}) {
  const t = await getTranslations('ListingAnalytics');
  const result = await readListingAnalytics({ cursor, days }, { cookieHeader: await currentCookieHeader() });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const page = (result as { kind: 'ok'; data: ListingAnalyticsResponse }).data;

  const window = days === null ? '' : `&days=${encodeURIComponent(days)}`;

  return (
    <section aria-labelledby="listing-analytics" className="mt-10">
      <h2 id="listing-analytics" className="text-lg font-medium text-neutral-900">
        {t('windowLabel')}: {t('windowValue', { days: page.days })}
      </h2>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('readOnlyNote')}</p>
      {/* Stated, not implied: the two things this rollup does not count, and why. */}
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('notCountedNote')}</p>

      {page.items.length === 0 ? (
        <Notice title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <>
          <ul className="mt-4 space-y-3">
            {page.items.map((row) => (
              <li
                key={`${row.day}-${row.listingSlug}`}
                className="rounded-lg border border-neutral-200 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-medium text-neutral-900">{row.listingTitle}</p>
                    <p className="mt-1 text-sm text-neutral-600">
                      {t('dayHeading')}: {row.day}
                    </p>
                  </div>
                  <p className="text-sm text-neutral-600">
                    {t('sellerHeading')}: {row.sellerSlug ?? t('noSeller')}
                  </p>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <Cell label={t('clicksHeading')} value={row.clicks} />
                  <Cell label={t('contactsHeading')} value={row.contacts} />
                  <Cell label={t('favoritesHeading')} value={row.favorites} />
                  <Cell label={t('sharesHeading')} value={row.shares} />
                  <Cell label={t('statusHeading')} value={row.listingStatus} />
                </dl>
                <p className="mt-2 text-xs text-neutral-500">
                  {t('computedHeading')}: {minute(row.computedAt)}
                </p>
              </li>
            ))}
          </ul>

          {page.nextCursor !== null && (
            <p className="mt-4">
              <Link
                href={`/analytics/listings?cursor=${encodeURIComponent(page.nextCursor)}${window}`}
                className="underline underline-offset-4"
              >
                {t('nextPage')}
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  );
}
