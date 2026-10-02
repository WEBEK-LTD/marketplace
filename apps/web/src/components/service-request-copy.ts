import type { ServiceRequestCopy } from './service-request-views';

/**
 * The service request surface's words, assembled once (Phase 7-I).
 *
 * Both sides render the same card and the same detail from the same message keys, so the copy is built here
 * rather than twice. The two namespaces — `ServiceRequests` for the buyer's pages and `SellerServiceRequests`
 * for the seller's — carry the same key set, which the message-parity test holds each of them to; only the
 * headings differ, and those stay on the pages.
 *
 * **Only the side's own words are built, in the group that uses them.** These become RSC payload, so a seller's
 * page that assembled the buyer's labels would ship "accept this quote" into a document where that step does
 * not exist — and one shared object would ship the accept words into a page that draws only a cancel button.
 * So the controls get three separate groups, the side travels inside them rather than as a second argument,
 * and the buyer's form is `null` rather than an unused object.
 *
 * **The validity window and the payment deadline have separate labels.** A seller states how long their quote
 * stands; the platform's configured window sets when money becomes due on an accepted one. They are different
 * facts from different places, and one label for both would be the kind of conflation that makes somebody miss
 * a payment.
 */
export function serviceRequestCopy(
  t: (key: string, values?: Record<string, number>) => string,
  side: 'buyer' | 'seller',
): ServiceRequestCopy {
  return {
    listLabel: t('listLabel'),
    brief: t('brief'),
    budget: t('budget'),
    budgetNone: t('budgetNone'),
    neededBy: t('neededBy'),
    status: t('status'),
    statuses: {
      open: t('statusOpen'),
      quoted: t('statusQuoted'),
      accepted: t('statusAccepted'),
      declined: t('statusDeclined'),
      cancelled: t('statusCancelled'),
      expired: t('statusExpired'),
    },
    counterparty: t('counterparty'),
    platformHandled: t('platformHandled'),
    platformNote: t('platformNote'),
    quotesLabel: t('quotesLabel'),
    quotesCount: (count: number) => t('quotesCount', { count }),
    noQuotes: t('noQuotes'),
    awaitingQuote: t('awaitingQuote'),
    quoteHeading: t('quoteHeading'),
    quoteAmount: t('quoteAmount'),
    quoteDelivery: t('quoteDelivery'),
    quoteRevisions: t('quoteRevisions'),
    quoteScope: t('quoteScope'),
    quoteStatuses: {
      sent: t('quoteStatusSent'),
      accepted: t('quoteStatusAccepted'),
      rejected: t('quoteStatusRejected'),
      withdrawn: t('quoteStatusWithdrawn'),
      expired: t('quoteStatusExpired'),
    },
    quoteLapsed: t('quoteLapsed'),
    quoteValidUntil: t('quoteValidUntil'),
    paymentDeadline: t('paymentDeadline'),
    paymentDueNote: t('paymentDueNote'),
    days: (count: number) => t('days', { count }),
    openRequest: t('openRequest'),
    openService: t('openService'),
    actions:
      side === 'seller'
        ? {
            side: 'seller',
            closure: {
              step: 'decline',
              label: t('declineRequest'),
              question: t('confirmDeclineRequest'),
              ...shared(t),
            },
            decision: { side: 'seller', withdraw: t('withdrawQuote'), ...shared(t) },
            form: {
              heading: t('quoteHeading'),
              send: t('sendQuote'),
              amountLabel: t('quoteAmountLabel'),
              amountHint: t('quoteAmountHint'),
              deliveryLabel: t('quoteDeliveryLabel'),
              revisionsLabel: t('quoteRevisionsLabel'),
              scopeLabel: t('quoteScopeLabel'),
              validForLabel: t('quoteValidForLabel'),
              validForHint: t('quoteValidForHint'),
              amountRequired: t('amountRequired'),
              scopeRequired: t('scopeRequired'),
              ...shared(t),
            },
          }
        : {
            side: 'buyer',
            closure: {
              step: 'cancel',
              label: t('cancelRequest'),
              question: t('confirmCancelRequest'),
              ...shared(t),
            },
            decision: {
              side: 'buyer',
              accept: t('acceptQuote'),
              reject: t('rejectQuote'),
              confirmAccept: t('confirmAcceptQuote'),
              ...shared(t),
            },
            // A buyer never quotes, so a buyer's page carries none of the form's words at all.
            form: null,
          },
  };
}

function shared(t: (key: string, values?: Record<string, number>) => string) {
  return {
    confirm: t('confirm'),
    cancel: t('cancel'),
    working: t('working'),
    failedDecided: t('failedDecided'),
    failedLapsed: t('failedLapsed'),
    failedPaymentPolicy: t('failedPaymentPolicy'),
    failedBlocked: t('failedBlocked'),
    failedGeneric: t('failedGeneric'),
    failedSignedOut: t('failedSignedOut'),
  } as const;
}
