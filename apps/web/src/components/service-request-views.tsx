import Link from 'next/link';
import type { ServiceQuote, ServiceRequestDetail, ServiceRequestSummary } from '@repo/contracts';
import { formatListingAmount } from './listing-price';
import {
  ServiceQuoteDecision,
  ServiceQuoteForm,
  ServiceRequestClosure,
  type ServiceRequestActionCopy,
} from './service-request-actions';

/**
 * The service request list and detail (Phase 7-I).
 *
 * **Server components.** Everything either party reads about a brief or a quote — the title, the brief, the
 * budget, the date, the status, the scope, the amount, the validity window, the payment deadline — is rendered
 * here, on the server. Only the buttons and the quote form are client components, and what crosses to them is
 * one or two identifiers, a currency code and a handful of words. Nothing else about a negotiation is in the
 * RSC payload.
 *
 * **The two time facts are separate, and are labelled separately.** A quote's validity window is when the
 * quote stops standing; a payment deadline is when money becomes due on one that was accepted. They come from
 * different places — the seller states the first, the platform's configured window sets the second — they mean
 * different things to the person reading them, and they are never shown as one field or under one heading.
 *
 * **A lapsed quote is told the truth about.** `isLapsed` means the validity window has passed while the status
 * still says `sent`, because the scheduled sweeper has not run yet. Such a quote is shown as closed and offers
 * no steps — which is what the database will also say, so no button here promises something that always
 * refuses.
 *
 * **There is no payment control anywhere in this file.** An accepted quote shows the amount and the deadline;
 * paying it is Phase 8's, and a button that looked like a payment would be a lie.
 *
 * **Nothing here decides who the reader is.** `isBuyer` and `isSeller` arrive already derived from the account
 * the API established, and the side's words arrive with them. This file reads both and computes neither.
 */

export interface ServiceRequestCopy {
  readonly listLabel: string;
  readonly brief: string;
  readonly budget: string;
  readonly budgetNone: string;
  readonly neededBy: string;
  readonly status: string;
  readonly statuses: Readonly<Record<string, string>>;
  readonly counterparty: string;
  /** 7-J: who answers this brief. Shown instead of a storefront when nobody does. */
  readonly platformHandled: string;
  readonly platformNote: string;
  readonly quotesLabel: string;
  readonly quotesCount: (count: number) => string;
  readonly noQuotes: string;
  readonly awaitingQuote: string;
  readonly quoteHeading: string;
  readonly quoteAmount: string;
  readonly quoteDelivery: string;
  readonly quoteRevisions: string;
  readonly quoteScope: string;
  readonly quoteStatuses: Readonly<Record<string, string>>;
  readonly quoteLapsed: string;
  readonly quoteValidUntil: string;
  readonly paymentDeadline: string;
  readonly paymentDueNote: string;
  readonly days: (count: number) => string;
  readonly openRequest: string;
  readonly openService: string;
  readonly actions: ServiceRequestActionCopy;
}

/** A timestamp shown to the minute, in the value the API sent. No zone arithmetic happens here. */
function minute(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

/** Live means the schema's own definition: nothing has closed the brief yet. */
function isLive(request: { readonly closedAt: string | null }): boolean {
  return request.closedAt === null;
}

/* ------------------------------------------------------------------------------------------------ */
/* The list                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

function SummaryCard({
  request,
  copy,
  href,
  servicePath,
}: {
  readonly request: ServiceRequestSummary;
  readonly copy: ServiceRequestCopy;
  readonly href: string;
  readonly servicePath: string | null;
}) {
  const budget = formatListingAmount(request.budgetMinor, request.currencyCode, request.currencyMinorUnit);

  return (
    <li className="rounded-lg border border-neutral-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-medium text-neutral-900">
            <Link href={href} className="underline underline-offset-4">
              {request.title}
            </Link>
          </p>
          {request.routingMode === 'admin_only' ? (
            /* 7-J: no storefront answers this one, so the card says who does rather than showing a gap. */
            <p className="mt-1 text-sm text-neutral-600">{copy.platformHandled}</p>
          ) : (
            request.counterpartyName !== null && (
              <p className="mt-1 text-sm text-neutral-600">
                <span className="text-xs text-neutral-600">{copy.counterparty}: </span>
                {request.counterpartyName}
              </p>
            )
          )}
        </div>
        <span className="rounded-full border border-neutral-400 px-2 py-0.5 text-xs font-medium text-neutral-800">
          {copy.statuses[request.status] ?? request.status}
        </span>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
        <div>
          <dt className="text-xs text-neutral-600">{copy.budget}</dt>
          <dd className="font-semibold text-neutral-900">
            {budget ?? copy.budgetNone}
          </dd>
        </div>
        {request.neededBy !== null && (
          <div>
            <dt className="text-xs text-neutral-600">{copy.neededBy}</dt>
            <dd>
              <time dateTime={request.neededBy}>{request.neededBy}</time>
            </dd>
          </div>
        )}
        {/* An Admin Only brief has no quotes and never will, so a count of them is not shown. */}
        {request.routingMode !== 'admin_only' && (
          <div>
            <dt className="text-xs text-neutral-600">{copy.quotesLabel}</dt>
            <dd>{copy.quotesCount(request.quoteCount)}</dd>
          </div>
        )}
        {/* The payment deadline of the accepted quote, if this brief has one. The only obligation a list shows. */}
        {request.acceptedPaymentDueAt !== null && (
          <div>
            <dt className="text-xs text-neutral-600">{copy.paymentDeadline}</dt>
            <dd className="font-medium text-neutral-900">
              <time dateTime={request.acceptedPaymentDueAt}>{minute(request.acceptedPaymentDueAt)}</time>
            </dd>
          </div>
        )}
      </dl>

      <p className="mt-3 flex flex-wrap gap-4 text-sm">
        <Link href={href} className="underline underline-offset-4">
          {copy.openRequest}
        </Link>
        {servicePath !== null && (
          <Link href={servicePath} className="underline underline-offset-4">
            {copy.openService}
          </Link>
        )}
      </p>
    </li>
  );
}

/**
 * One page of briefs, from whichever side is looking.
 *
 * The same card on both sides: `counterpartyName` is the storefront on the buyer's list and the buyer's name
 * on the seller's, because a list answers "who is this with" and each side already knows which side it is on.
 */
export function ServiceRequestList({
  items,
  copy,
  base,
  localePrefix,
}: {
  readonly items: readonly ServiceRequestSummary[];
  readonly copy: ServiceRequestCopy;
  /** Where a row's detail lives: this list's own address. */
  readonly base: string;
  readonly localePrefix: string;
}) {
  return (
    <ul aria-label={copy.listLabel} className="mt-6 space-y-4">
      {items.map((request) => (
        <SummaryCard
          key={request.id}
          request={request}
          copy={copy}
          href={`${base}/${request.id}`}
          servicePath={
            request.listingSlug === null
              ? null
              : `${localePrefix}/service/${encodeURIComponent(request.listingSlug)}`
          }
        />
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The detail                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

function QuoteCard({
  quote,
  requestId,
  currencyCode,
  currencyMinorUnit,
  copy,
  requestLive,
}: {
  readonly quote: ServiceQuote;
  readonly requestId: string;
  readonly currencyCode: string;
  readonly currencyMinorUnit: number;
  readonly copy: ServiceRequestCopy;
  readonly requestLive: boolean;
}) {
  const amount = formatListingAmount(quote.amountMinor, currencyCode, currencyMinorUnit);
  // A quote past its window is closed whatever the stored status still says, and a quote on a closed brief
  // cannot be acted on either. Both are what the database will answer, so neither offers a control.
  const decidable = quote.status === 'sent' && !quote.isLapsed && requestLive;

  return (
    <li className="rounded-lg border border-neutral-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-base font-semibold text-neutral-900">{amount ?? '—'}</p>
        <span className="rounded-full border border-neutral-400 px-2 py-0.5 text-xs font-medium text-neutral-800">
          {quote.isLapsed && quote.status === 'sent'
            ? copy.quoteLapsed
            : (copy.quoteStatuses[quote.status] ?? quote.status)}
        </span>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
        <div>
          <dt className="text-xs text-neutral-600">{copy.quoteDelivery}</dt>
          <dd>{copy.days(quote.deliveryDays)}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-600">{copy.quoteRevisions}</dt>
          <dd>{quote.revisionsIncluded}</dd>
        </div>
        {/* The validity window: when this quote stops standing. */}
        {quote.status === 'sent' && (
          <div>
            <dt className="text-xs text-neutral-600">{copy.quoteValidUntil}</dt>
            <dd>
              <time dateTime={quote.expiresAt}>{minute(quote.expiresAt)}</time>
            </dd>
          </div>
        )}
        {/* The payment deadline: a different thing, from a different place, under its own label. */}
        {quote.paymentDueAt !== null && (
          <div>
            <dt className="text-xs text-neutral-600">{copy.paymentDeadline}</dt>
            <dd className="font-medium text-neutral-900">
              <time dateTime={quote.paymentDueAt}>{minute(quote.paymentDueAt)}</time>
            </dd>
          </div>
        )}
      </dl>

      <p className="mt-3 max-w-prose whitespace-pre-line text-sm text-neutral-700">
        <span className="text-xs text-neutral-600">{copy.quoteScope}: </span>
        {quote.scope}
      </p>

      {quote.status === 'accepted' && quote.paymentDueAt !== null && (
        <p
          role="status"
          className="mt-3 max-w-prose rounded-md border border-neutral-300 p-3 text-sm text-neutral-800"
        >
          {copy.paymentDueNote}
        </p>
      )}

      {decidable && (
        <div className="mt-4">
          <ServiceQuoteDecision requestId={requestId} quoteId={quote.id} copy={copy.actions.decision} />
        </div>
      )}
    </li>
  );
}

/** One brief in full, with its quotes and whatever steps this side may take on it. */
export function ServiceRequestDetailView({
  request,
  copy,
  localePrefix,
}: {
  readonly request: ServiceRequestDetail;
  readonly copy: ServiceRequestCopy;
  readonly localePrefix: string;
}) {
  const live = isLive(request);
  const budget = formatListingAmount(request.budgetMinor, request.currencyCode, request.currencyMinorUnit);
  const platform = request.routingMode === 'admin_only';
  const counterparty = request.isBuyer ? request.sellerName : request.buyerName;
  // Only a seller's page is given a form at all, and whether another quote may be sent is the existing
  // trigger's rule — restated here only to decide what to draw: a live brief takes another quote, a closed
  // one does not.
  const form = copy.actions.form;
  const quotable = form !== null && live;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-medium text-neutral-900">{request.title}</p>
          {platform ? (
            <p className="mt-1 text-sm text-neutral-600">{copy.platformHandled}</p>
          ) : (
            counterparty !== null && (
              <p className="mt-1 text-sm text-neutral-600">
                <span className="text-xs text-neutral-600">{copy.counterparty}: </span>
                {counterparty}
              </p>
            )
          )}
        </div>
        <span className="rounded-full border border-neutral-400 px-2 py-0.5 text-xs font-medium text-neutral-800">
          {copy.statuses[request.status] ?? request.status}
        </span>
      </div>

      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
        <div>
          <dt className="text-xs text-neutral-600">{copy.budget}</dt>
          <dd className="font-semibold text-neutral-900">
            {budget ?? copy.budgetNone}
          </dd>
        </div>
        {request.neededBy !== null && (
          <div>
            <dt className="text-xs text-neutral-600">{copy.neededBy}</dt>
            <dd>
              <time dateTime={request.neededBy}>{request.neededBy}</time>
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-neutral-600">{copy.status}</dt>
          <dd>{copy.statuses[request.status] ?? request.status}</dd>
        </div>
      </dl>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-neutral-900">{copy.brief}</h2>
        <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-neutral-700">{request.brief}</p>
      </section>

      {request.listingSlug !== null && (
        <p className="mt-4 text-sm">
          <Link
            href={`${localePrefix}/service/${encodeURIComponent(request.listingSlug)}`}
            className="underline underline-offset-4"
          >
            {copy.openService}
          </Link>
        </p>
      )}

      {/*
        7-J: an Admin Only brief has no quote and no seller, so the quotes section is **absent** rather than
        empty — an empty one would say "no quote yet, the seller will answer", which is not true of a brief no
        seller ever sees. What replaces it is a sentence saying who is handling it.
      */}
      {platform ? (
        <p role="status" className="mt-8 max-w-prose rounded-md border border-neutral-300 p-3 text-sm text-neutral-800">
          {copy.platformNote}
        </p>
      ) : (
      <section className="mt-8">
        <h2 aria-label={copy.quotesLabel} className="text-sm font-medium text-neutral-900">
          {copy.quotesLabel}
        </h2>
        {request.quotes.length === 0 ? (
          <p className="mt-2 max-w-prose text-sm text-neutral-600">
            {copy.actions.side === 'buyer' ? copy.awaitingQuote : copy.noQuotes}
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {request.quotes.map((quote) => (
              <QuoteCard
                key={quote.id}
                quote={quote}
                requestId={request.id}
                currencyCode={request.currencyCode}
                currencyMinorUnit={request.currencyMinorUnit}
                copy={copy}
                requestLive={live}
              />
            ))}
          </ul>
        )}
      </section>
      )}

      {quotable && !platform && (
        <div className="mt-6">
          <ServiceQuoteForm requestId={request.id} currencyCode={request.currencyCode} copy={form} />
        </div>
      )}

      {live && (
        <div className="mt-6">
          <ServiceRequestClosure requestId={request.id} copy={copy.actions.closure} />
        </div>
      )}
    </div>
  );
}
