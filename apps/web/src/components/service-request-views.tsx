import Link from 'next/link';
import type { ServiceRequestDetail, ServiceRequestSummary } from '@repo/contracts';
import { formatListingAmount } from './listing-price';
import {
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
    <li className="rounded-lg border border-hairline p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-medium text-ink-strong">
            <Link href={href} className="underline underline-offset-4">
              {request.title}
            </Link>
          </p>
          {request.routingMode === 'admin_only' ? (
            /* 7-J: no storefront answers this one, so the card says who does rather than showing a gap. */
            <p className="mt-1 text-sm text-ink-muted">{copy.platformHandled}</p>
          ) : (
            request.counterpartyName !== null && (
              <p className="mt-1 text-sm text-ink-muted">
                <span className="text-xs text-ink-muted">{copy.counterparty}: </span>
                {request.counterpartyName}
              </p>
            )
          )}
        </div>
        <span className="rounded-full border border-edge px-2 py-0.5 text-xs font-medium text-ink-body">
          {copy.statuses[request.status] ?? request.status}
        </span>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-body">
        <div>
          <dt className="text-xs text-ink-muted">{copy.budget}</dt>
          <dd className="font-semibold text-ink-strong">
            {budget ?? copy.budgetNone}
          </dd>
        </div>
        {request.neededBy !== null && (
          <div>
            <dt className="text-xs text-ink-muted">{copy.neededBy}</dt>
            <dd>
              <time dateTime={request.neededBy}>{request.neededBy}</time>
            </dd>
          </div>
        )}
        {/* An Admin Only brief has no quotes and never will, so a count of them is not shown. */}
        {request.routingMode !== 'admin_only' && (
          <div>
            <dt className="text-xs text-ink-muted">{copy.quotesLabel}</dt>
            <dd>{copy.quotesCount(request.quoteCount)}</dd>
          </div>
        )}
        {/* The payment deadline of the accepted quote, if this brief has one. The only obligation a list shows. */}
        {request.acceptedPaymentDueAt !== null && (
          <div>
            <dt className="text-xs text-ink-muted">{copy.paymentDeadline}</dt>
            <dd className="font-medium text-ink-strong">
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

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-medium text-ink-strong">{request.title}</p>
          {/* Every enquiry is handled by the office (OD-A4), so there is no counterparty to name. */}
          <p className="mt-1 text-sm text-ink-muted">{copy.platformHandled}</p>
        </div>
        <span className="rounded-full border border-edge px-2 py-0.5 text-xs font-medium text-ink-body">
          {copy.statuses[request.status] ?? request.status}
        </span>
      </div>

      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-body">
        <div>
          <dt className="text-xs text-ink-muted">{copy.budget}</dt>
          <dd className="font-semibold text-ink-strong">
            {budget ?? copy.budgetNone}
          </dd>
        </div>
        {request.neededBy !== null && (
          <div>
            <dt className="text-xs text-ink-muted">{copy.neededBy}</dt>
            <dd>
              <time dateTime={request.neededBy}>{request.neededBy}</time>
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-ink-muted">{copy.status}</dt>
          <dd>{copy.statuses[request.status] ?? request.status}</dd>
        </div>
      </dl>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-ink-strong">{copy.brief}</h2>
        <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-ink-body">{request.brief}</p>
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
        **There is no quotes section, and that is the model rather than an empty state.** 7-J had already
        dropped it for an Admin Only brief, on the grounds that "no quote yet, the seller will answer" is
        untrue of a brief no seller sees. OD-A4 made every enquiry that kind, so what used to be a branch is
        now simply the page: a sentence saying who is handling it, and no quote list, decision or form
        anywhere. The contract still carries a `quotes` array because the database reader is unchanged; it
        can only ever be empty, since 0110 closed every writer that could add to it.
      */}
      <p role="status" className="mt-8 max-w-prose rounded-md border border-edge p-3 text-sm text-ink-body">
        {copy.platformNote}
      </p>

      {live && (
        <div className="mt-6">
          <ServiceRequestClosure requestId={request.id} copy={copy.actions.closure} />
        </div>
      )}
    </div>
  );
}
