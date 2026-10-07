import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  AdminServiceRequestDetail,
  AdminServiceRequestsResponse,
  ServiceRequestPaymentInformation,
} from '@repo/contracts';
import {
  readAdminServiceRequest,
  readAdminServiceRequests,
  readServiceRequestPaymentInformation,
  type AdminServiceRequestResult,
} from '../server/bff';
import { currentCookieHeader } from '../server/current-staff';
import { AdminServiceRequestDeclineForm } from './admin-service-request-decline-form';
import { adminPath } from '../paths';

/**
 * The Admin Only service request screens — Option 2 (Phase 7-J).
 *
 * **Both are server components rendered *inside* `RequireStaff`.** That placement is the whole of the RSC
 * protection: a gate that refuses never invokes `children`, so a subtree a person may not see is never
 * rendered, never serialized and never streamed. Nothing here is hidden with CSS and nothing is filtered in
 * the browser.
 *
 * **They fetch nothing until they render**, because the reads live in the gated subtree rather than in the page
 * function — so a refused request performs no read at all.
 *
 * **The Payment Information section is a separate read, and it is absent rather than empty.** It is fetched by
 * its own function from its own endpoint, which the API refuses without
 * `service_requests.payment_info.read`. A colleague who holds only the request permission gets `notFound` from
 * that read and this file renders **no heading at all** — not an empty section, which would itself say that
 * there was something they could not see. The request read has no field for either value, so there is nothing
 * here that could leak one by mistake.
 *
 * **Every state is a state, not an absence.** Empty queue, unreadable answer, ended session, no such request
 * and an already-closed request each have their own rendering, because somebody who cannot tell "nothing is
 * waiting" from "we could not ask" will eventually act on the wrong one.
 *
 * **No quote, no checkout, no payment and no seller anywhere.** Option 2 produces none of them; the only action
 * on these screens is the one approved closure, and nothing here charges, reserves or orders anything.
 */

/* ------------------------------------------------------------------------------------------------ */
/* The queue                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export async function AdminServiceRequestQueue({
  status,
  cursor,
}: {
  readonly status: string | null;
  readonly cursor: string | null;
}) {
  const t = await getTranslations('ServiceRequests');
  const result = await readAdminServiceRequests(
    { status, cursor },
    { cookieHeader: await currentCookieHeader() },
  );

  const failure = await refusal(result, t);
  if (failure !== null) return failure;
  const page = (result as { kind: 'ok'; data: AdminServiceRequestsResponse }).data;

  return (
    <>
      <nav aria-label={t('filterLabel')} className="mt-6 flex flex-wrap gap-2">
        <FilterLink current={status} value={null} label={t('filter.all')} />
        <FilterLink current={status} value="open" label={t('status.open')} />
        <FilterLink current={status} value="declined" label={t('status.declined')} />
        <FilterLink current={status} value="cancelled" label={t('status.cancelled')} />
      </nav>

      {page.items.length === 0 ? (
        <div className="mt-8 rounded-lg border border-neutral-200 p-6" role="status">
          <p className="text-base font-medium text-neutral-900">{t('emptyTitle')}</p>
          <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('emptyBody')}</p>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {page.items.map((item) => (
            <li key={item.id} className="rounded-lg border border-neutral-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-base font-medium text-neutral-900">
                    <Link
                      href={adminPath(`/service-requests/${item.id}`)}
                      className="underline underline-offset-4"
                    >
                      {item.title}
                    </Link>
                  </p>
                  <p className="mt-1 text-sm text-neutral-600">
                    <span className="text-xs text-neutral-600">{t('buyer')}: </span>
                    {item.buyerName ?? t('buyerUnknown')}
                  </p>
                </div>
                <StatusBadge label={t(`status.${item.status}`)} />
              </div>

              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
                <Cell label={t('budget')} value={money(item.budgetMinor, item.currencyCode, item.currencyMinorUnit) ?? t('budgetNone')} />
                {item.neededBy !== null && <Cell label={t('neededBy')} value={item.neededBy} />}
                <Cell label={t('sentAt')} value={minute(item.createdAt)} />
                {/*
                  A boolean, never a value: the queue says whether there is more to read without being the
                  place it is read. Reading it requires the second permission and a different screen.
                */}
                <Cell label={t('paymentNotesPresent')} value={item.hasPaymentNotes ? t('yes') : t('no')} />
              </dl>

              <p className="mt-3 text-sm">
                <Link href={adminPath(`/service-requests/${item.id}`)} className="underline underline-offset-4">
                  {t('open')}
                </Link>
              </p>
            </li>
          ))}
        </ul>
      )}

      {page.nextCursor !== null && (
        <Link
          href={adminPath(`/service-requests?${new URLSearchParams({
            ...(status === null ? {} : { status }),
            cursor: page.nextCursor,
          }).toString()}`)}
          className="mt-6 inline-block text-sm underline underline-offset-4"
        >
          {t('next')}
        </Link>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The detail                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export async function AdminServiceRequestDetailView({ requestId }: { readonly requestId: string }) {
  const t = await getTranslations('ServiceRequests');
  const cookieHeader = await currentCookieHeader();
  const result = await readAdminServiceRequest(requestId, { cookieHeader });

  const failure = await refusal(result, t);
  if (failure !== null) return failure;
  const request = (result as { kind: 'ok'; data: AdminServiceRequestDetail }).data;

  return (
    <>
      <div className="mt-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-medium text-neutral-900">{request.title}</p>
          <p className="mt-1 text-sm text-neutral-600">
            <span className="text-xs text-neutral-600">{t('buyer')}: </span>
            {request.buyerName ?? t('buyerUnknown')}
          </p>
        </div>
        <StatusBadge label={t(`status.${request.status}`)} />
      </div>

      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
        <Cell label={t('budget')} value={money(request.budgetMinor, request.currencyCode, request.currencyMinorUnit) ?? t('budgetNone')} />
        {request.neededBy !== null && <Cell label={t('neededBy')} value={request.neededBy} />}
        <Cell label={t('sentAt')} value={minute(request.createdAt)} />
        <Cell label={t('updatedAt')} value={minute(request.updatedAt)} />
        {request.closedAt !== null && <Cell label={t('closedAt')} value={minute(request.closedAt)} />}
      </dl>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-neutral-900">{t('briefHeading')}</h2>
        <p className="mt-2 max-w-prose whitespace-pre-line text-sm text-neutral-700">{request.brief}</p>
      </section>

      {/* Its own read, its own permission, and absent when that read refuses. */}
      <PaymentInformation requestId={request.id} cookieHeader={cookieHeader} />

      <p className="mt-8 max-w-prose rounded-md border border-neutral-300 p-3 text-sm text-neutral-800" role="note">
        {t('noSellerNote')}
      </p>

      {/* The one approved action, and only while the request is still open. */}
      {request.status === 'open' && (
        <div className="mt-6">
          <AdminServiceRequestDeclineForm
            requestId={request.id}
            copy={{
              action: t('declineAction'),
              question: t('declineQuestion'),
              confirm: t('confirm'),
              cancel: t('cancel'),
              working: t('working'),
              failedDecided: t('failedDecided'),
              failedNotFound: t('failedNotFound'),
              failedSignedOut: t('failedSignedOut'),
              failedGeneric: t('failedGeneric'),
            }}
          />
        </div>
      )}
    </>
  );
}

/**
 * The Payment Information section.
 *
 * Rendered only when its own read succeeds. A caller without `service_requests.payment_info.read` gets
 * `notFound` and this returns `null` — **no heading, no empty state, nothing**. That is deliberate: an empty
 * "Payment Information" box would tell somebody that there is information they are not being shown, which is
 * itself something the permission is meant to withhold.
 *
 * An outage is different from a refusal and says so, because a colleague who may read this needs to know the
 * difference between "there is none" and "we could not ask".
 */
async function PaymentInformation({
  requestId,
  cookieHeader,
}: {
  readonly requestId: string;
  readonly cookieHeader: string | null;
}) {
  const t = await getTranslations('ServiceRequests');
  const result = await readServiceRequestPaymentInformation(requestId, { cookieHeader });

  if (result.kind === 'notFound' || result.kind === 'unauthenticated' || result.kind === 'invalid') {
    return null;
  }
  if (result.kind === 'unavailable') {
    return (
      <section className="mt-8">
        <h2 className="text-sm font-medium text-neutral-900">{t('paymentHeading')}</h2>
        <p role="status" className="mt-2 max-w-prose text-sm text-neutral-600">
          {t('paymentUnavailable')}
        </p>
      </section>
    );
  }

  const payment: ServiceRequestPaymentInformation = result.data;
  const purged = payment.preferredPaymentMethod === null && payment.paymentNotes === null;

  return (
    <section className="mt-8 rounded-lg border border-neutral-300 p-4">
      <h2 className="text-sm font-medium text-neutral-900">{t('paymentHeading')}</h2>
      <p className="mt-1 max-w-prose text-xs text-neutral-600">{t('paymentDescriptiveOnly')}</p>

      {purged ? (
        <p role="status" className="mt-3 max-w-prose text-sm text-neutral-600">
          {t('paymentPurged')}
        </p>
      ) : (
        <dl className="mt-3 space-y-3 text-sm text-neutral-700">
          <div>
            <dt className="text-xs text-neutral-600">{t('paymentMethod')}</dt>
            <dd className="whitespace-pre-line text-neutral-900">
              {payment.preferredPaymentMethod ?? t('paymentNone')}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-600">{t('paymentNotes')}</dt>
            <dd className="max-w-prose whitespace-pre-line">{payment.paymentNotes ?? t('paymentNone')}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */

async function refusal(
  result: AdminServiceRequestResult<unknown>,
  t: Awaited<ReturnType<typeof getTranslations<'ServiceRequests'>>>,
): Promise<React.ReactElement | null> {
  if (result.kind === 'ok') return null;
  const shell = await getTranslations('Console');
  if (result.kind === 'unauthenticated') {
    return <Notice title={shell('signedOutTitle')} body={shell('signedOutBody')} />;
  }
  if (result.kind === 'notFound') {
    return <Notice title={t('notFoundTitle')} body={t('notFoundBody')} />;
  }
  if (result.kind === 'invalid') {
    return <Notice title={t('cursorTitle')} body={t('cursorBody')} />;
  }
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

function StatusBadge({ label }: { readonly label: string }) {
  return (
    <span className="rounded-full border border-neutral-400 px-2 py-0.5 text-xs font-medium text-neutral-800">
      {label}
    </span>
  );
}

function FilterLink({
  current,
  value,
  label,
}: {
  readonly current: string | null;
  readonly value: string | null;
  readonly label: string;
}) {
  const active = current === value;
  const href = value === null ? '/service-requests' : `/service-requests?status=${value}`;
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'rounded-full border border-neutral-900 px-3 py-1 text-xs font-medium text-neutral-900'
          : 'rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-700'
      }
    >
      {label}
    </Link>
  );
}

/** A timestamp to the minute, in the value the API sent. No zone arithmetic happens here. */
function minute(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

/**
 * A minor-unit amount, rendered without a money library.
 *
 * The API states the decimal places authoritatively, so the string is split rather than divided: a float would
 * be a precision decision nobody made, and this console shows somebody's budget.
 */
function money(minor: string | null, currencyCode: string, decimals: number): string | null {
  if (minor === null || !/^[0-9]+$/.test(minor)) return null;
  if (decimals === 0) return `${currencyCode} ${minor}`;
  const padded = minor.padStart(decimals + 1, '0');
  return `${currencyCode} ${padded.slice(0, padded.length - decimals)}.${padded.slice(padded.length - decimals)}`;
}
