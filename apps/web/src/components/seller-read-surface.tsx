import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ListingMessage } from './listing-views';
import { RequireSession } from './require-session';
import { SellerDashboardNav } from './seller-dashboard-nav';

/**
 * The shell every read-only seller surface renders inside (Phase 6-J).
 *
 * **There is no `'use client'` anywhere in 6-J.** Every one of the five surfaces is a server component from
 * the page down, including this shell and the pagination links, which are ordinary anchors. That is the
 * strongest form of the RSC-payload rule the earlier increments worked at: nothing crosses a client boundary
 * because there is no client boundary — no order, review, balance, promotion or analytics row is ever
 * serialised into flight data for a component to hydrate, and nothing needs narrowing because nothing is
 * passed. It is also the honest shape for these pages: nothing on them mutates, so nothing needs a handler.
 *
 * **Protection is 5-A's, unchanged.** Everything is inside {@link RequireSession}, a server component rather
 * than a layout, for the reason 6-B established and every seller increment since has repeated: a layout that
 * declines to render `children` still streams the page segment's payload, so a signed-out visitor would
 * receive somebody's orders and balances in the flight data of a page they never see.
 *
 * **The four states are kept apart on purpose**, and the one that matters most is the last: `unavailable` is
 * never rendered as an empty list. "You have no orders" when a request timed out would tell a seller their
 * business had vanished.
 */

export type SellerSurfaceState =
  | { readonly kind: 'ok' }
  | { readonly kind: 'not_a_seller' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

export interface SellerReadSurfaceProps {
  readonly locale: string;
  readonly title: string;
  readonly intro: string;
  readonly state: SellerSurfaceState;
  /** What a failing read says as its heading. Each surface names itself, never "error". */
  readonly unavailableTitle: string;
  readonly unavailableDescription: string;
  readonly notASellerLabel: string;
  readonly dashboardLabel: string;
  readonly sessionBody: string;
  readonly signInLabel: string;
  readonly children: ReactNode;
}

const LINK =
  'text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary';

export function SellerReadSurface({
  locale,
  title,
  intro,
  state,
  unavailableTitle,
  unavailableDescription,
  notASellerLabel,
  dashboardLabel,
  sessionBody,
  signInLabel,
  children,
}: SellerReadSurfaceProps) {
  const prefix = locale === 'ar' ? '/ar' : '';

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{title}</Heading>

          <SellerDashboardNav locale={locale} />

          {state.kind === 'not_a_seller' ? (
            <div role="status" className="mt-8">
              <p className="text-ink-strong">{notASellerLabel}</p>
              <p className="mt-4">
                <Link href={`${prefix}/dashboard/seller`} className={LINK}>
                  {dashboardLabel}
                </Link>
              </p>
            </div>
          ) : state.kind === 'unauthenticated' ? (
            <div role="status" className="mt-8">
              <p className="max-w-prose text-ink-muted">{sessionBody}</p>
              <p className="mt-4">
                <Link href={`${prefix}/login`} className={LINK}>
                  {signInLabel}
                </Link>
              </p>
            </div>
          ) : state.kind === 'unavailable' ? (
            // Deliberately not an empty state: a failing read must never read as "you have none of these".
            <div className="mt-8">
              <ListingMessage
                tone="error"
                title={unavailableTitle}
                description={unavailableDescription}
              />
            </div>
          ) : (
            <>
              <p className="mt-8 max-w-prose text-ink-body">{intro}</p>
              {children}
            </>
          )}
        </div>
      </PageContainer>
    </RequireSession>
  );
}

/**
 * The next-page link.
 *
 * An ordinary anchor carrying the opaque cursor, so paging works with no JavaScript at all and the cursor
 * never has to reach a client component to be useful.
 */
export function SellerSurfacePager({
  locale,
  path,
  cursor,
  label,
}: {
  readonly locale: string;
  readonly path: string;
  readonly cursor: string | null;
  readonly label: string;
}) {
  if (cursor === null) return null;
  const prefix = locale === 'ar' ? '/ar' : '';
  return (
    <p className="mt-6">
      <Link href={`${prefix}${path}?cursor=${encodeURIComponent(cursor)}`} className={LINK}>
        {label}
      </Link>
    </p>
  );
}

/** A labelled value, which is most of what these pages are. */
export function SellerFact({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="text-sm font-medium text-ink-strong">{value}</dd>
      {hint === undefined ? null : <dd className="text-xs text-ink-muted">{hint}</dd>}
    </div>
  );
}
