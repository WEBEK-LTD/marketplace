import type { SellerIdentity } from '@repo/contracts';

/**
 * The seller account panel (Phase 6-B).
 *
 * A server component with no state, no fetch and no interactivity — so the seller identity it receives
 * never crosses into a client bundle or an RSC payload as props. That is why this is not a client
 * component: there is nothing here that needs to be one, and a component that did would have to be handed
 * a narrowed projection instead of the contract.
 *
 * It renders the six fields the contract carries and has no expression that could render a seventh. The
 * status is shown as an approved label rather than the stored token, so a reader sees "Suspended" rather
 * than a vocabulary word, and never sees *why* — the suspension reason is not in the contract and has no
 * place on this page.
 *
 * A description list, because that is what this is: labelled facts about one account, in a structure a
 * screen reader can navigate.
 */

export interface SellerAccountLabels {
  readonly account: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly city: string;
  readonly country: string;
  readonly statusLabel: (status: SellerIdentity['status']) => string;
  readonly verificationLabel: (status: SellerIdentity['verificationStatus']) => string;
}

export function SellerAccountView({
  seller,
  labels,
}: {
  readonly seller: SellerIdentity;
  readonly labels: SellerAccountLabels;
}) {
  return (
    <section aria-labelledby="seller-account" className="mt-8">
      <h2 id="seller-account" className="text-lg font-semibold text-ink-strong">
        {labels.account}
      </h2>

      {/* The storefront's own name, which is the one piece of free text on this page. */}
      <p className="mt-2 text-base text-ink-strong">{seller.displayName}</p>

      <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
        <div className="flex justify-between gap-4 border-b border-hairline py-2">
          <dt className="text-sm text-ink-muted">{labels.status}</dt>
          <dd className="text-sm font-medium text-ink-strong">{labels.statusLabel(seller.status)}</dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-hairline py-2">
          <dt className="text-sm text-ink-muted">{labels.verificationStatus}</dt>
          <dd className="text-sm font-medium text-ink-strong">
            {labels.verificationLabel(seller.verificationStatus)}
          </dd>
        </div>
        {seller.city === null ? null : (
          <div className="flex justify-between gap-4 border-b border-hairline py-2">
            <dt className="text-sm text-ink-muted">{labels.city}</dt>
            <dd className="text-sm text-ink-strong">{seller.city}</dd>
          </div>
        )}
        <div className="flex justify-between gap-4 border-b border-hairline py-2">
          <dt className="text-sm text-ink-muted">{labels.country}</dt>
          <dd className="text-sm text-ink-strong">{seller.countryCode}</dd>
        </div>
      </dl>
    </section>
  );
}
