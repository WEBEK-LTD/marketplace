import Link from 'next/link';
import type { Offer, SellerOffer } from '@repo/contracts';
import { formatListingAmount } from './listing-price';
import { OfferActions, type OfferActionCopy } from './offer-actions';

/**
 * The two offer lists (Phase 7-H).
 *
 * **Server components.** Everything a page shows about an offer — the amount, the quantity, the note, the
 * status, the two deadlines — is rendered here, on the server. Only the buttons are a client component, and
 * what crosses to them is one identifier and a handful of words. Nothing else about a negotiation is in the
 * RSC payload.
 *
 * **The two deadlines are separate, and are labelled separately.** A negotiation window is when the offer
 * stops standing; a payment deadline is when money becomes due on one that was accepted. They come from
 * different settings, they mean different things to the person reading them, and they are never shown as
 * one field or under one heading.
 *
 * **A lapsed offer is told the truth about.** `isLapsed` means the negotiation window has passed while the
 * status still says `pending`, because the scheduled sweeper has not run yet. Such an offer is shown as
 * closed and offers no actions — which is what the database will also say, so no button here promises
 * something that always refuses.
 *
 * **There is no payment action anywhere in this file.** An accepted offer shows the amount and the deadline;
 * paying it is Phase 8's, and a button that looked like a payment would be a lie.
 */

export interface OfferCopy {
  readonly listLabel: string;
  readonly amount: string;
  readonly quantity: string;
  readonly note: string;
  readonly status: string;
  readonly statuses: Readonly<Record<string, string>>;
  readonly lapsed: string;
  readonly negotiationDeadline: string;
  readonly paymentDeadline: string;
  readonly paymentDueNote: string;
  readonly awaitingSeller: string;
  readonly counterOf: string;
  readonly openListing: string;
  readonly actions: OfferActionCopy;
}

/** One offer, from whichever side is looking. */
function OfferCard({
  offer,
  copy,
  localePrefix,
  counterparty,
}: {
  readonly offer: Offer | SellerOffer;
  readonly copy: OfferCopy;
  readonly localePrefix: string;
  readonly counterparty: string | null;
}) {
  const amount = formatListingAmount(offer.amountMinor, offer.currencyCode, offer.currencyMinorUnit);
  const closed = offer.status !== 'pending' || offer.isLapsed;

  return (
    <li className="rounded-lg border border-neutral-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-medium text-neutral-900">{offer.listingTitle}</p>
          {counterparty !== null && (
            <p className="mt-1 text-sm text-neutral-600">{counterparty}</p>
          )}
        </div>
        <span className="rounded-full border border-neutral-400 px-2 py-0.5 text-xs font-medium text-neutral-800">
          {offer.isLapsed ? copy.lapsed : (copy.statuses[offer.status] ?? offer.status)}
        </span>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
        <div>
          <dt className="text-xs text-neutral-600">{copy.amount}</dt>
          <dd className="font-semibold text-neutral-900">{amount ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-600">{copy.quantity}</dt>
          <dd>{offer.quantity}</dd>
        </div>
        {/* The negotiation window. Shown while it still means something. */}
        {!closed && (
          <div>
            <dt className="text-xs text-neutral-600">{copy.negotiationDeadline}</dt>
            <dd>
              <time dateTime={offer.expiresAt}>{offer.expiresAt.slice(0, 16).replace('T', ' ')}</time>
            </dd>
          </div>
        )}
        {/* The payment deadline. A different thing, from a different setting, under its own label. */}
        {offer.paymentDueAt !== null && (
          <div>
            <dt className="text-xs text-neutral-600">{copy.paymentDeadline}</dt>
            <dd className="font-medium text-neutral-900">
              <time dateTime={offer.paymentDueAt}>
                {offer.paymentDueAt.slice(0, 16).replace('T', ' ')}
              </time>
            </dd>
          </div>
        )}
      </dl>

      {offer.message !== null && (
        <p className="mt-3 max-w-prose text-sm text-neutral-700">
          <span className="text-xs text-neutral-600">{copy.note}: </span>
          {offer.message}
        </p>
      )}

      {offer.parentOfferId !== null && (
        <p className="mt-2 text-xs text-neutral-600">{copy.counterOf}</p>
      )}

      {offer.status === 'accepted' && offer.paymentDueAt !== null && (
        <p className="mt-3 max-w-prose rounded-md border border-neutral-300 p-3 text-sm text-neutral-800" role="status">
          {copy.paymentDueNote}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Link
          href={`${localePrefix}/listing/${offer.listingSlug}`}
          className="text-sm underline underline-offset-4"
        >
          {copy.openListing}
        </Link>
        {closed ? null : (
          <OfferActions offerId={offer.id} currencyCode={offer.currencyCode} copy={copy.actions} />
        )}
      </div>

      {!closed && copy.actions.side === 'buyer' && (
        <p className="mt-2 text-xs text-neutral-600">{copy.awaitingSeller}</p>
      )}
    </li>
  );
}

/** The offers the reader has made. */
export function OffersMadeList({
  items,
  copy,
  localePrefix,
}: {
  readonly items: readonly Offer[];
  readonly copy: OfferCopy;
  readonly localePrefix: string;
}) {
  return (
    <ul aria-label={copy.listLabel} className="mt-8 space-y-3">
      {items.map((offer) => (
        <OfferCard
          key={offer.id}
          offer={offer}
          copy={copy}
          localePrefix={localePrefix}
          counterparty={offer.sellerDisplayName}
        />
      ))}
    </ul>
  );
}

/** The offers made to the reader's storefront. */
export function OffersReceivedList({
  items,
  copy,
  localePrefix,
}: {
  readonly items: readonly SellerOffer[];
  readonly copy: OfferCopy;
  readonly localePrefix: string;
}) {
  return (
    <ul aria-label={copy.listLabel} className="mt-8 space-y-3">
      {items.map((offer) => (
        <OfferCard
          key={offer.id}
          offer={offer}
          copy={copy}
          localePrefix={localePrefix}
          counterparty={offer.buyerDisplayName}
        />
      ))}
    </ul>
  );
}
