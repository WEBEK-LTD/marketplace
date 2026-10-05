import type { OfferCopy } from './offer-views';

/**
 * The offer list's words, assembled once (Phase 7-H).
 *
 * Both pages render the same card from the same message keys, so the copy is built here rather than twice.
 * The two namespaces — `Offers` for the buyer's page and `SellerOffers` for the seller's — carry the same
 * key set, which the message-parity test holds them to; only the headings differ, and those stay on the
 * pages.
 *
 * The two deadlines have separate labels on purpose: a negotiation window and a payment deadline are
 * different facts from different settings, and one label for both would be the kind of conflation that
 * makes somebody miss a payment.
 */
export function offerCopy(t: (key: string) => string, side: 'buyer' | 'seller'): OfferCopy {
  return {
    listLabel: t('listLabel'),
    amount: t('amount'),
    quantity: t('quantity'),
    note: t('note'),
    status: t('status'),
    statuses: {
      pending: t('statusPending'),
      accepted: t('statusAccepted'),
      rejected: t('statusRejected'),
      countered: t('statusCountered'),
      withdrawn: t('statusWithdrawn'),
      expired: t('statusExpired'),
    },
    lapsed: t('lapsed'),
    negotiationDeadline: t('negotiationDeadline'),
    paymentDeadline: t('paymentDeadline'),
    paymentDueNote: t('paymentDueNote'),
    awaitingSeller: t('awaitingSeller'),
    counterOf: t('counterOf'),
    openListing: t('openListing'),
    // Only the side's own words. These become RSC payload, so the other side's are not built at all.
    actions:
      side === 'seller'
        ? {
            side: 'seller',
            accept: t('accept'),
            reject: t('reject'),
            confirmAccept: t('confirmAccept'),
            ...shared(t),
          }
        : {
            side: 'buyer',
            counter: t('counter'),
            withdraw: t('withdraw'),
            amountLabel: t('amountLabel'),
            quantityLabel: t('quantityLabel'),
            noteLabel: t('noteLabel'),
            send: t('send'),
            amountRequired: t('amountRequired'),
            ...shared(t),
          },
  };
}

function shared(t: (key: string) => string) {
  return {
    confirm: t('confirm'),
    cancel: t('cancel'),
    working: t('working'),
    failedDecided: t('failedDecided'),
    failedLapsed: t('failedLapsed'),
    failedGeneric: t('failedGeneric'),
    failedSignedOut: t('failedSignedOut'),
  } as const;
}
