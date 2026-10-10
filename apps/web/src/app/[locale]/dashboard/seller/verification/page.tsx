import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ListingMessage } from '../../../../../components/listing-views';
import { RequireSession } from '../../../../../components/require-session';
import { SellerDashboardNav } from '../../../../../components/seller-dashboard-nav';
import { verificationActions } from '../../../../../components/seller-verification';
import {
  SellerVerificationPanel,
  type RenderableDocument,
  type RenderableVerification,
  type VerificationDocumentLabels,
  type VerificationPanelLabels,
  type VerificationStartLabels,
  type VerificationSubmitLabels,
} from '../../../../../components/seller-verification-panel';
import { readSellerIdentity, readSellerVerification } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerVerification');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * `/dashboard/seller/verification` — the seller's own verification submission (Phase 6-I).
 *
 * **Protection is 5-A's, unchanged.** Everything below is inside {@link RequireSession}, a server component
 * rather than a layout, for the reason 6-B established and 6-D, 6-F and 6-G repeated: a layout that declines
 * to render `children` still streams the page segment's RSC payload, so a signed-out visitor would receive
 * somebody's identity documents in the flight data of a page they never see.
 *
 * **Everything is read on the server**, and projected field by field before it reaches the one client
 * component that renders it. A client component's props become part of the RSC payload, so the projection is
 * what decides what a browser gets — and what it deliberately never gets is the verification's id, the
 * seller's id, any object path, the reviewer, the review time, the decision reason and any document's review
 * note. None of those is in the contract this page reads, and none is constructed here.
 *
 * **Owner decision 2 is enforced by what this page renders at all.** A `verified` storefront is shown its
 * verified state and nothing else: no form, no start control, no "verify again", and — because the label
 * groups are built only for permitted actions — none of that copy is in the payload either.
 *
 * **Owner decision 1 is why there is no document counter gating the submit control.** There is no minimum,
 * so nothing here counts documents before offering to send the application; the hint says as much in plain
 * words rather than implying a threshold that does not exist.
 *
 * **Nothing on this page decides a verification.** There is no approve, no reject, no reason field and no
 * admin view — not disabled, absent. A decision is the reviewer's, and this surface cannot express one.
 */

export default async function SellerVerificationPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
}) {
  const [{ locale }, t, dashboard, session, sellers] = await Promise.all([
    params,
    getTranslations('SellerVerification'),
    getTranslations('SellerDashboard'),
    getTranslations('Session'),
    getTranslations('Sellers'),
  ]);
  const prefix = locale === 'ar' ? '/ar' : '';

  const cookieHeader = (await headers()).get('cookie');
  const [identity, lookup] = await Promise.all([
    readSellerIdentity({ cookieHeader }),
    readSellerVerification({ cookieHeader }),
  ]);

  const typeLabels: Readonly<Record<string, string>> = {
    national_id: t('typeNationalId'),
    passport: t('typePassport'),
    commercial_register: t('typeCommercialRegister'),
    tax_card: t('typeTaxCard'),
    bank_statement: t('typeBankStatement'),
    other: t('typeOther'),
  };

  const statusLabel = (status: string): string => {
    if (status === 'submitted') return t('statusSubmitted');
    if (status === 'under_review') return t('statusUnderReview');
    if (status === 'approved') return t('statusApproved');
    if (status === 'rejected') return t('statusRejected');
    if (status === 'expired') return t('statusExpired');
    return t('statusDraft');
  };

  const documentStatusLabel = (status: string): string => {
    if (status === 'accepted') return t('documentStatusAccepted');
    if (status === 'rejected') return t('documentStatusRejected');
    return t('documentStatusPending');
  };

  const panelLabels: VerificationPanelLabels = {
    statusLabel: t('statusLabel'),
    contact: t('contact'),
    emailVerified: t('emailVerified'),
    phoneVerified: t('phoneVerified'),
    contactYes: t('contactYes'),
    contactNo: t('contactNo'),
    contactHint: t('contactHint'),
    documents: t('documents'),
    noDocuments: t('noDocuments'),
    confirm: t('confirm'),
    cancel: t('cancel'),
    errorExists: t('errorExists'),
    errorAlreadyVerified: t('errorAlreadyVerified'),
    errorNotEditable: t('errorNotEditable'),
    errorPathTaken: t('errorPathTaken'),
    errorMissingObject: t('errorMissingObject'),
    errorInvalid: t('errorInvalid'),
    errorNotFound: t('errorNotFound'),
    errorUnavailable: t('errorUnavailable'),
  };

  // One label group per action this state actually offers, and null for the rest. A control the state does
  // not allow therefore has no copy to render with, and its copy is not in the RSC payload either.
  const startLabels = (): VerificationStartLabels => ({
    noAttempt: t('noAttempt'),
    start: t('start'),
    starting: t('starting'),
  });
  const documentLabels = (): VerificationDocumentLabels => ({
    documentType: t('documentType'),
    chooseFile: t('chooseFile'),
    add: t('add'),
    adding: t('adding'),
    added: t('added'),
    allowedTypes: t('allowedTypes'),
    noFile: t('noFile'),
    typeNotAllowed: t('typeNotAllowed'),
    tooLarge: t('tooLarge'),
    remove: t('remove'),
    removing: t('removing'),
    removed: t('removed'),
    removeConfirm: t('removeConfirm'),
    typeLabels,
  });
  const submitLabels = (): VerificationSubmitLabels => ({
    submit: t('submit'),
    submitting: t('submitting'),
    submitted: t('submitted'),
    submitConfirm: t('submitConfirm'),
    submitHint: t('submitHint'),
  });

  /** The attempt, projected field by field. Seven fields per document, and no path among them. */
  const render = (): RenderableVerification | null => {
    if (lookup.kind !== 'ok') return null;
    const documents: RenderableDocument[] = lookup.verification.documents.map((document) => ({
      id: document.id,
      documentType: document.documentType,
      originalFilename: document.originalFilename,
      status: document.status,
      typeLabel: typeLabels[document.documentType] ?? document.documentType,
      statusLabel: documentStatusLabel(document.status),
    }));
    return {
      status: lookup.verification.status,
      statusLabel: statusLabel(lookup.verification.status),
      emailVerified: lookup.verification.emailVerified,
      phoneVerified: lookup.verification.phoneVerified,
      documents,
    };
  };

  const verificationStatus = identity.kind === 'ok' ? identity.seller.verificationStatus : '';
  const actions = verificationActions(
    verificationStatus,
    lookup.kind === 'ok' ? lookup.verification : null,
  );
  const isVerified = verificationStatus === 'verified';

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>

          <SellerDashboardNav locale={locale} />

          {identity.kind === 'not_a_seller' || lookup.kind === 'not_a_seller' ? (
            <div role="status" className="mt-8">
              <p className="text-ink-strong">{dashboard('notASeller')}</p>
              <p className="mt-4">
                <Link
                  href={`${prefix}/dashboard/seller`}
                  className="text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
                >
                  {dashboard('title')}
                </Link>
              </p>
            </div>
          ) : identity.kind === 'unauthenticated' || lookup.kind === 'unauthenticated' ? (
            <div role="status" className="mt-8">
              <p className="max-w-prose text-ink-muted">{session('expiredBody')}</p>
              <p className="mt-4">
                <Link
                  href={`${prefix}/login`}
                  className="text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
                >
                  {session('signIn')}
                </Link>
              </p>
            </div>
          ) : identity.kind === 'unavailable' || lookup.kind === 'unavailable' ? (
            // Deliberately not folded into the "you have not applied" state: a failing service must never
            // read as "you have never applied", which would tell somebody their application had vanished.
            <div className="mt-8">
              <ListingMessage
                tone="error"
                title={t('errorUnavailable')}
                description={sellers('error')}
              />
            </div>
          ) : (
            <>
              <p className="mt-8 max-w-prose text-ink-body">{t('intro')}</p>

              {isVerified ? (
                // Owner decision 2: the verified state, and nothing else. No form, no start control, no
                // suggestion that verifying again is a thing that exists.
                <div role="status" className="mt-6 rounded-lg border border-hairline p-4">
                  <p className="text-ink-strong">{t('verified')}</p>
                </div>
              ) : (
                <>
                  {actions.awaitingReview ? (
                    <p role="status" className="mt-6 max-w-prose text-sm text-ink-muted">
                      {lookup.kind === 'ok' && lookup.verification.status === 'submitted'
                        ? t('submittedNote')
                        : t('awaitingReview')}
                    </p>
                  ) : null}

                  {lookup.kind === 'ok' &&
                  ['approved', 'rejected', 'expired'].includes(lookup.verification.status) ? (
                    // A decided attempt: what happened, and that somebody will be in touch. No reason, no
                    // reviewer, no appeal machinery — none of that is in the contract, and none of it is
                    // this page's to invent.
                    <p role="status" className="mt-6 max-w-prose text-sm text-ink-muted">
                      {t('decided')}
                    </p>
                  ) : null}

                  <SellerVerificationPanel
                    verification={render()}
                    labels={panelLabels}
                    start={actions.canStart ? startLabels() : null}
                    documents={
                      actions.canAddDocuments || actions.canRemoveDocuments
                        ? documentLabels()
                        : null
                    }
                    submit={actions.canSubmit ? submitLabels() : null}
                  />
                </>
              )}
            </>
          )}
        </div>
      </PageContainer>
    </RequireSession>
  );
}
