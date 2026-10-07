import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  AdminRoleCatalogueResponse,
  AdminSellerDetail,
  AdminSellerPageResponse,
  AdminUserDetail,
  AdminUserPageResponse,
  AuditPageResponse,
  RecoveryEvidenceResponse,
  RecoveryQueueResponse,
  RecoveryRequestDetail,
} from '@repo/contracts';
import {
  readAdminAudit,
  readAdminRoleCatalogue,
  readAdminSeller,
  readAdminSellers,
  readAdminUser,
  readAdminUserRoles,
  readAdminUserSecurityEvents,
  readAdminUsers,
  readRecoveryEvidence,
  readRecoveryQueue,
  readRecoveryRequest,
  readStaffGrantableRoles,
  type AdminOperationsResult,
} from '../server/bff';
import { currentCookieHeader } from '../server/current-staff';
import { RecoveryDecisionForm, SellerStatusForm, StaffRoleForm } from './admin-operations-forms';
import { adminPath } from '../paths';

/**
 * The seller, user, recovery and audit screens (Phase 7-O).
 *
 * **Every one is a server component rendered *inside* `RequireStaff`.** That placement is the whole of the
 * RSC protection: a gate that refuses never invokes `children`, so a subtree a colleague may not see is never
 * rendered, never serialized and never streamed. Nothing here is hidden with CSS and nothing is filtered in
 * the browser.
 *
 * **They fetch nothing until they render**, because the reads live in the gated subtree rather than in the
 * page function — so a refused request performs no read at all.
 *
 * **Each read is gated twice more, and the keys are deliberately not held together.** A page's own gate
 * checks the section's key; the API requires the key that read needs; the database re-applies the same test
 * with the key as a literal. So on the account screen, a colleague holding `users.profile.read` and not
 * `users.role.read` gets the account and **no roles panel at all** — absent, not empty. An empty "Roles"
 * heading would itself say there was something they could not see.
 *
 * **The controls are shipped only where they apply.** A recovery request the caller may not act on ships no
 * control, and the words for a control that is not on the screen are not in the payload, which is why each
 * form's copy is assembled next to the branch that renders it. A caller who is the account holder or the
 * reviewer receives the explanation instead of the control, because the database is going to refuse them and
 * saying so beforehand is kinder than a failed request.
 *
 * **There is no control anywhere in this file that grants or removes a role.** `public.user_roles` is written
 * by nothing in this repository, and that writer is deferred to its own increment by owner decision — so the
 * account screen says so on the page rather than leaving a colleague hunting for a button that was never
 * built.
 *
 * **The seller screen does carry one control**, and it offers only the statuses the storefront can legally
 * reach from where it is: a list computed next to the branch that renders it, so the words for an unreachable
 * status are not in the payload. A closed storefront gets no control at all, because `closed` is terminal.
 *
 * **No account is ever named except the one being administered.** The contracts carry `isSelf`,
 * `isOwnRequest`, `isTheReviewer`, `reviewedByMe` and `isOwnAction` and no colleague's identity at all, so
 * there is nothing in this file that could render who reviewed a recovery or who changed an audited row —
 * only whether it was the reader.
 *
 * **The audit screen renders names, never values.** `changedColumns` is the whole of what a row says about
 * what changed, and there is no `oldValues` or `newValues` in the contract to render.
 *
 * **Every state is a state, not an absence.** Empty list, unreadable answer, ended session, a row that is not
 * this caller's to see, and a request already decided each have their own rendering.
 */

type Translate = Awaited<ReturnType<typeof getTranslations<'AdminOps'>>>;

/** A timestamp shown to the minute, in the value the API sent. No zone arithmetic happens here. */
function minute(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

async function refusal(
  result: AdminOperationsResult<unknown>,
  t: Translate,
): Promise<React.ReactElement | null> {
  if (result.kind === 'ok') return null;
  const shell = await getTranslations('Console');
  if (result.kind === 'unauthenticated') {
    return <Notice title={shell('signedOutTitle')} body={shell('signedOutBody')} />;
  }
  if (result.kind === 'notFound') return <Notice title={t('notFoundTitle')} body={t('notFoundBody')} />;
  if (result.kind === 'invalid') return <Notice title={t('cursorTitle')} body={t('cursorBody')} />;
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

function Badge({ label }: { readonly label: string }) {
  return (
    <span className="rounded-full border border-neutral-400 px-2 py-0.5 text-xs font-medium text-neutral-800">
      {label}
    </span>
  );
}

function NextPage({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <p className="mt-6 text-sm">
      <Link href={href} className="underline underline-offset-4">
        {label}
      </Link>
    </p>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Storefronts                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export async function AdminSellerList({
  cursor,
  status,
  verificationStatus,
}: {
  readonly cursor: string | null;
  readonly status: string | null;
  readonly verificationStatus: string | null;
}) {
  const t = await getTranslations('AdminOps');
  const result = await readAdminSellers(
    { cursor, status, verificationStatus },
    { cookieHeader: await currentCookieHeader() },
  );

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const page = (result as { kind: 'ok'; data: AdminSellerPageResponse }).data;

  if (page.items.length === 0) {
    return <Notice title={t('sellersEmptyTitle')} body={t('sellersEmptyBody')} />;
  }

  const filters = [
    status === null ? '' : `&status=${encodeURIComponent(status)}`,
    verificationStatus === null ? '' : `&verificationStatus=${encodeURIComponent(verificationStatus)}`,
  ].join('');

  return (
    <>
      <ul className="mt-6 space-y-3">
        {page.items.map((seller) => (
          <li key={seller.slug} className="rounded-lg border border-neutral-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-medium text-neutral-900">
                  <Link
                    href={adminPath(`/sellers/storefront/${seller.slug}`)}
                    className="underline underline-offset-4"
                  >
                    {seller.displayName}
                  </Link>
                </p>
                <p className="mt-1 text-sm text-neutral-600">{seller.slug}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge label={t(`sellerStatus.${seller.status}`)} />
                <Badge label={t(`verification.${seller.verificationStatus}`)} />
              </div>
            </div>

            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
              <Cell label={t('listingsLabel')} value={String(seller.listingCount)} />
              <Cell label={t('openReportsLabel')} value={String(seller.openReportCount)} />
              {seller.city !== null && <Cell label={t('cityLabel')} value={seller.city} />}
              <Cell label={t('joinedLabel')} value={minute(seller.createdAt)} />
            </dl>
          </li>
        ))}
      </ul>
      {page.nextCursor !== null && (
        <NextPage
          href={adminPath(`/sellers?cursor=${encodeURIComponent(page.nextCursor)}${filters}`)}
          label={t('nextPage')}
        />
      )}
    </>
  );
}

export async function AdminSellerDetailView({ slug }: { readonly slug: string }) {
  const t = await getTranslations('AdminOps');
  const result = await readAdminSeller(slug, { cookieHeader: await currentCookieHeader() });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const seller = (result as { kind: 'ok'; data: AdminSellerDetail }).data;
  // No capability, no control: a colleague holding only the seller read key is shipped neither the
  // control nor the words for it, which is why this is a capability on the row rather than a guess here.
  const targets = seller.canManage ? reachableStatuses(seller) : [];

  return (
    <section aria-labelledby="seller-name" className="mt-6">
      <h2 id="seller-name" className="text-lg font-medium text-neutral-900">
        {seller.displayName}
      </h2>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge label={t(`sellerStatus.${seller.status}`)} />
        <Badge label={t(`verification.${seller.verificationStatus}`)} />
      </div>

      {seller.bio !== null && <p className="mt-4 max-w-prose text-neutral-800">{seller.bio}</p>}

      <dl
        aria-label={t('storefrontFacts')}
        className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3"
      >
        <Cell label={t('slugLabel')} value={seller.slug} />
        <Cell label={t('listingsLabel')} value={String(seller.listingCount)} />
        <Cell label={t('liveListingsLabel')} value={String(seller.liveListingCount)} />
        <Cell label={t('openReportsLabel')} value={String(seller.openReportCount)} />
        {seller.city !== null && <Cell label={t('cityLabel')} value={seller.city} />}
        {seller.governorate !== null && (
          <Cell label={t('governorateLabel')} value={seller.governorate} />
        )}
        <Cell label={t('joinedLabel')} value={minute(seller.createdAt)} />
        {seller.verifiedAt !== null && (
          <Cell label={t('verifiedAtLabel')} value={minute(seller.verifiedAt)} />
        )}
        {seller.suspendedAt !== null && (
          <Cell label={t('suspendedAtLabel')} value={minute(seller.suspendedAt)} />
        )}
        {seller.closedAt !== null && <Cell label={t('closedAtLabel')} value={minute(seller.closedAt)} />}
      </dl>

      {seller.suspensionReason !== null && (
        <div className="mt-4 rounded-lg border border-neutral-200 p-4">
          <p className="text-xs text-neutral-600">{t('suspensionReasonLabel')}</p>
          <p className="mt-1 max-w-prose text-sm text-neutral-900">{seller.suspensionReason}</p>
        </div>
      )}

      {seller.isOwnStorefront && (
        <p role="status" className="mt-4 text-sm text-neutral-600">
          {t('ownStorefrontHint')}
        </p>
      )}

      {/*
        The statuses this storefront can legally reach from where it is, which is the same matrix 0079 holds —
        stated here only to decide what to put on the screen, never to decide whether a move is allowed. The
        database refuses anything this list gets wrong, and a status that is not reachable is absent rather
        than disabled, so its label never reaches the payload.

        `closed` is terminal, so a closed storefront yields an empty list and the control is not rendered at
        all. `active` appears only from `suspended` and only when the storefront is verified; `pending` only
        from `suspended` and only when it is not. Activating a `pending` storefront is 7-G's approval, which
        is why it is absent here.
      */}
      {!seller.canManage ? null : targets.length === 0 ? (
        <p role="status" className="mt-6 max-w-prose text-sm text-neutral-600">
          {t('sellerTerminalNote')}
        </p>
      ) : (
        <SellerStatusForm
          slug={seller.slug}
          copy={{
            heading: t('statusHeading'),
            intro: t('statusIntro'),
            statusLabel: t('statusLabel'),
            reasonLabel: t('reasonLabel'),
            reasonHint: t('reasonHint'),
            submit: t('statusSubmit'),
            confirmSuspend: t('confirmSuspend'),
            confirmClose: t('confirmClose'),
            confirmReinstate: t('confirmReinstate'),
            cancel: t('cancel'),
            working: t('working'),
            failed: t('failed'),
            conflict: t('conflict'),
            notAllowed: t('statusNotAllowed'),
            signedOut: t('signedOut'),
            targets: targets.map((value) => ({ value, label: t(`sellerStatus.${value}`) })),
          }}
        />
      )}

      {/*
        The gap that remains, said on the page: verification is 7-G's and role assignment has no writer at all.
      */}
      <p className="mt-6 max-w-prose text-sm text-neutral-600">{t('sellerVerificationNote')}</p>
    </section>
  );
}

/**
 * Which statuses one storefront can legally reach from where it is.
 *
 * The seven legal pairs, as a destination list. This decides what the screen offers and nothing else: 0079
 * applies the same matrix with the row locked, so a list that drifted from it would simply produce a refusal
 * rather than an illegal move.
 */
function reachableStatuses(seller: AdminSellerDetail): readonly string[] {
  // Terminal. Nothing reopens a closed storefront.
  if (seller.status === 'closed') return [];
  if (seller.status === 'suspended') {
    // The two reinstatement conditions, as complements — plus closure, which is available from all three.
    return [seller.verificationStatus === 'verified' ? 'active' : 'pending', 'closed'];
  }
  // `pending` and `active` can both be suspended or closed. `pending → active` is 7-G's approval, not this.
  return ['suspended', 'closed'];
}

/* ------------------------------------------------------------------------------------------------ */
/* Accounts                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export async function AdminUserList({
  cursor,
  status,
}: {
  readonly cursor: string | null;
  readonly status: string | null;
}) {
  const t = await getTranslations('AdminOps');
  const result = await readAdminUsers(
    { cursor, status },
    { cookieHeader: await currentCookieHeader() },
  );

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const page = (result as { kind: 'ok'; data: AdminUserPageResponse }).data;

  if (page.items.length === 0) {
    return <Notice title={t('usersEmptyTitle')} body={t('usersEmptyBody')} />;
  }

  return (
    <>
      <ul className="mt-6 space-y-3">
        {page.items.map((user) => (
          <li key={user.id} className="rounded-lg border border-neutral-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-medium text-neutral-900">
                  <Link href={adminPath(`/users/${user.id}`)} className="underline underline-offset-4">
                    {user.displayName ?? t('noDisplayName')}
                  </Link>
                </p>
                <p className="mt-1 text-sm text-neutral-600">
                  {t(`accountStatus.${user.status}`)}
                  {user.isSelf ? ` · ${t('isSelfLabel')}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {user.isStaff && <Badge label={t('staffLabel')} />}
                {user.isSeller && <Badge label={t('sellerLabel')} />}
              </div>
            </div>

            {/* Whether a channel was confirmed. The contact itself is not in the contract at all. */}
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
              <Cell
                label={t('emailVerifiedLabel')}
                value={user.hasVerifiedEmail ? t('yes') : t('no')}
              />
              <Cell
                label={t('phoneVerifiedLabel')}
                value={user.hasVerifiedPhone ? t('yes') : t('no')}
              />
              <Cell label={t('joinedLabel')} value={minute(user.createdAt)} />
            </dl>
          </li>
        ))}
      </ul>
      {page.nextCursor !== null && (
        <NextPage
          href={`/users?cursor=${encodeURIComponent(page.nextCursor)}${
            status === null ? '' : `&status=${encodeURIComponent(status)}`
          }`}
          label={t('nextPage')}
        />
      )}
    </>
  );
}

export async function AdminUserDetailView({ userId }: { readonly userId: string }) {
  const t = await getTranslations('AdminOps');
  const cookieHeader = await currentCookieHeader();
  const result = await readAdminUser(userId, { cookieHeader });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const user = (result as { kind: 'ok'; data: AdminUserDetail }).data;

  // Two further reads, each behind a key this caller may not hold. Both panels are absent rather than empty
  // when they come back with nothing, because an empty heading would itself disclose that there is
  // something here to see.
  const [roles, events, grantable] = await Promise.all([
    readAdminUserRoles(userId, { cookieHeader }),
    readAdminUserSecurityEvents(userId, { cookieHeader }),
    // 0100. A 404 here is a caller without `users.role.manage`, so the controls are absent rather than
    // disabled — and the list itself is the database's answer, never a catalogue this file filtered.
    readStaffGrantableRoles({ cookieHeader }),
  ]);

  // Which of the account's live grants this caller may withdraw: the grants that are currently effective,
  // intersected with the set the database says they may act on. Computed here on the server, from that set —
  // the writer applies the same ceiling again, so this decides what is *offered* and never what is allowed.
  const grantableOptions =
    grantable.kind === 'ok'
      ? grantable.data.items.map((item) => ({ roleKey: item.roleKey, label: item.nameEn }))
      : [];
  const grantableKeys = new Set(grantableOptions.map((item) => item.roleKey));
  const revocable =
    roles.kind === 'ok'
      ? roles.data.items
          .filter((role) => role.isEffective && grantableKeys.has(role.roleKey))
          .map((role) => ({ roleKey: role.roleKey, label: role.nameEn }))
      : [];

  return (
    <section aria-labelledby="account-name" className="mt-6">
      <h2 id="account-name" className="text-lg font-medium text-neutral-900">
        {user.displayName ?? t('noDisplayName')}
      </h2>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge label={t(`accountStatus.${user.status}`)} />
        {user.isStaff && <Badge label={t('staffLabel')} />}
        {user.isSeller && <Badge label={t('sellerLabel')} />}
      </div>

      <dl
        aria-label={t('accountFacts')}
        className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3"
      >
        <Cell label={t('emailVerifiedLabel')} value={user.hasVerifiedEmail ? t('yes') : t('no')} />
        <Cell label={t('phoneVerifiedLabel')} value={user.hasVerifiedPhone ? t('yes') : t('no')} />
        {user.localeCode !== null && <Cell label={t('localeLabel')} value={user.localeCode} />}
        {user.timezone !== null && <Cell label={t('timezoneLabel')} value={user.timezone} />}
        <Cell label={t('joinedLabel')} value={minute(user.createdAt)} />
        {user.lastSeenAt !== null && (
          <Cell label={t('lastSeenLabel')} value={minute(user.lastSeenAt)} />
        )}
      </dl>

      {/* The storefront is reached by its slug; no account identifier travels the other way. */}
      {user.sellerSlug !== null && (
        <p className="mt-4 text-sm">
          <Link
            href={adminPath(`/sellers/storefront/${user.sellerSlug}`)}
            className="underline underline-offset-4"
          >
            {t('openStorefront')}
          </Link>
        </p>
      )}

      {user.isSelf && (
        <p role="status" className="mt-4 text-sm text-neutral-600">
          {t('isSelfHint')}
        </p>
      )}

      {roles.kind === 'ok' && roles.data.items.length > 0 && (
        <section aria-labelledby="account-roles" className="mt-8">
          <h3 id="account-roles" className="text-base font-medium text-neutral-900">
            {t('rolesHeading')}
          </h3>
          <ul className="mt-3 space-y-3">
            {roles.data.items.map((role) => (
              <li key={role.roleKey} className="rounded-lg border border-neutral-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="text-sm font-medium text-neutral-900">{role.nameEn}</p>
                  <Badge label={role.isEffective ? t('roleEffective') : t('roleNotEffective')} />
                </div>
                <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
                  <Cell label={t('grantedAtLabel')} value={minute(role.grantedAt)} />
                  {role.expiresAt !== null && (
                    <Cell label={t('expiresAtLabel')} value={minute(role.expiresAt)} />
                  )}
                  {role.revokedAt !== null && (
                    <Cell label={t('revokedAtLabel')} value={minute(role.revokedAt)} />
                  )}
                  <Cell label={t('permissionsLabel')} value={String(role.permissionCount)} />
                  <Cell label={t('mfaLabel')} value={role.requiresMfa ? t('yes') : t('no')} />
                </dl>
              </li>
            ))}
          </ul>
          {/*
            The note is now about *this caller*: a colleague holding `users.role.read` and not
            `users.role.manage` still has nothing here to change a grant with, and is told so. A colleague who
            does hold the manage key gets the controls below instead.
          */}
          {grantable.kind === 'ok' ? null : (
            <p className="mt-4 max-w-prose text-sm text-neutral-600">{t('rolesReadOnlyNote')}</p>
          )}
        </section>
      )}

      {grantable.kind !== 'ok' ? null : grantableOptions.length === 0 && revocable.length === 0 ? (
        /*
          The caller holds the key and their own ceiling admits nothing on this account. Said on the server,
          because a client component carrying the words for controls nobody can use would ship them in the
          payload on every page view.
        */
        <section className="mt-8 rounded-lg border border-neutral-200 p-4">
          <h3 className="text-base font-medium text-neutral-900">{t('roleWriteHeading')}</h3>
          <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('roleNothingToDo')}</p>
          <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('roleSessionNote')}</p>
        </section>
      ) : (
        <StaffRoleForm
          grantable={grantableOptions}
          revocable={revocable}
          userId={userId}
          copy={{
            heading: t('roleWriteHeading'),
            intro: t('roleWriteIntro'),
            sessionNote: t('roleSessionNote'),
            reasonLabel: t('roleReasonLabel'),
            reasonHint: t('roleReasonHint'),
            cancel: t('cancel'),
            working: t('working'),
            failed: t('roleFailed'),
            signedOut: t('signedOut'),
            isSelf: t('roleIsSelf'),
            aboveCeiling: t('roleAboveCeiling'),
            notGrantable: t('roleNotGrantable'),
            notAssignable: t('roleNotAssignable'),
            alreadyRevoked: t('roleAlreadyRevoked'),
            expiryInvalid: t('roleExpiryInvalid'),
            reasonRequired: t('roleReasonRequired'),
            conflict: t('roleConflict'),
            // Only when there is something to grant, and only when there is something to withdraw.
            ...(grantableOptions.length === 0
              ? {}
              : {
                  roleLabel: t('roleLabel'),
                  expiresLabel: t('roleExpiresLabel'),
                  expiresHint: t('roleExpiresHint'),
                  grantSubmit: t('roleGrantSubmit'),
                  grantConfirm: t('roleGrantConfirm'),
                }),
            ...(revocable.length === 0
              ? {}
              : {
                  revokeSubmit: t('roleRevokeSubmit'),
                  revokeConfirm: t('roleRevokeConfirm'),
                  heldHeading: t('roleHeldHeading'),
                }),
          }}
        />
      )}

      {events.kind === 'ok' && events.data.items.length > 0 && (
        <section aria-labelledby="account-security" className="mt-8">
          <h3 id="account-security" className="text-base font-medium text-neutral-900">
            {t('securityHeading')}
          </h3>
          <ul className="mt-3 space-y-2">
            {events.data.items.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap justify-between gap-3 rounded-lg border border-neutral-200 px-4 py-3 text-sm"
              >
                <span className="text-neutral-900">{event.eventType}</span>
                <span className="text-neutral-600">{minute(event.occurredAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/** The role catalogue. Absent for a colleague who does not hold the key that reads it. */
export async function AdminRoleCatalogue() {
  const t = await getTranslations('AdminOps');
  const result = await readAdminRoleCatalogue({ cookieHeader: await currentCookieHeader() });
  if (result.kind !== 'ok') return null;
  const catalogue = (result.data as AdminRoleCatalogueResponse).items;
  if (catalogue.length === 0) return null;

  return (
    <section aria-labelledby="role-catalogue" className="mt-10">
      <h2 id="role-catalogue" className="text-lg font-medium text-neutral-900">
        {t('catalogueHeading')}
      </h2>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('catalogueIntro')}</p>
      <ul className="mt-4 space-y-3">
        {catalogue.map((role) => (
          <li key={role.roleKey} className="rounded-lg border border-neutral-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="text-sm font-medium text-neutral-900">{role.nameEn}</p>
              <div className="flex flex-wrap gap-2">
                {role.isAdminConsole && <Badge label={t('consoleRole')} />}
                {role.requiresMfa && <Badge label={t('mfaRole')} />}
              </div>
            </div>
            <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
              <Cell label={t('permissionsLabel')} value={String(role.permissionCount)} />
              <Cell label={t('holdersLabel')} value={String(role.holderCount)} />
              <Cell label={t('assignableLabel')} value={role.isAssignable ? t('yes') : t('no')} />
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Account recovery                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

export async function RecoveryQueue({
  cursor,
  status,
}: {
  readonly cursor: string | null;
  readonly status: string | null;
}) {
  const t = await getTranslations('AdminOps');
  const result = await readRecoveryQueue(
    { cursor, status },
    { cookieHeader: await currentCookieHeader() },
  );

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const page = (result as { kind: 'ok'; data: RecoveryQueueResponse }).data;

  if (page.items.length === 0) {
    return <Notice title={t('recoveryEmptyTitle')} body={t('recoveryEmptyBody')} />;
  }

  return (
    <>
      <ul className="mt-6 space-y-3">
        {page.items.map((request) => (
          <li key={request.id} className="rounded-lg border border-neutral-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-medium text-neutral-900">
                  <Link
                    href={adminPath(`/security/recovery/${request.id}`)}
                    className="underline underline-offset-4"
                  >
                    {t(`channel.${request.claimedContactChannel}`)}
                  </Link>
                </p>
                <p className="mt-1 text-sm text-neutral-600">{t('openRequest')}</p>
              </div>
              <Badge label={t(`recoveryStatus.${request.status}`)} />
            </div>

            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
              <Cell label={t('openedLabel')} value={minute(request.createdAt)} />
              <Cell label={t('evidenceLabel')} value={String(request.evidenceCount)} />
              <Cell
                label={t('matchedLabel')}
                value={request.matchedAnAccount ? t('yes') : t('no')}
              />
              <Cell label={t('expiresLabel')} value={minute(request.expiresAt)} />
            </dl>

            {/*
              Said before a colleague clicks in, because the writer is going to refuse them: 0028 refuses
              the account holder at every step and refuses the reviewer as the second approver.
            */}
            {request.isOwnRequest && (
              <p role="status" className="mt-3 text-sm text-neutral-600">
                {t('ownRequestHint')}
              </p>
            )}
            {!request.isOwnRequest && request.isTheReviewer && (
              <p role="status" className="mt-3 text-sm text-neutral-600">
                {t('isReviewerHint')}
              </p>
            )}
          </li>
        ))}
      </ul>
      {page.nextCursor !== null && (
        <NextPage
          href={`/security/recovery?cursor=${encodeURIComponent(page.nextCursor)}${
            status === null ? '' : `&status=${encodeURIComponent(status)}`
          }`}
          label={t('nextPage')}
        />
      )}
    </>
  );
}

export async function RecoveryRequestDetailView({ requestId }: { readonly requestId: string }) {
  const t = await getTranslations('AdminOps');
  const cookieHeader = await currentCookieHeader();
  const result = await readRecoveryRequest(requestId, { cookieHeader });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const request = (result as { kind: 'ok'; data: RecoveryRequestDetail }).data;

  const evidence = await readRecoveryEvidence(requestId, { cookieHeader });

  // Which step this request is at, and whether this colleague is the one who may take it. The database
  // decides all of it; this only decides what to put on the screen, and every branch that offers nothing
  // says why.
  //
  // Exactly one branch matches each state, which is why `submitted` and `under_review` are separated here
  // rather than both offering the review. 0028's writer accepts either — a reviewer may amend their own
  // note — but a request somebody has already reviewed needs a *decision* from somebody else, and offering
  // a second review there would hide the step that actually moves it. This console does not surface
  // amending a note; the workflow is the same either way.
  const canReview = !request.isOwnRequest && request.status === 'submitted';
  const canDecide = !request.isOwnRequest && !request.isTheReviewer && request.status === 'under_review';
  const canComplete =
    !request.isOwnRequest &&
    request.status === 'contact_verification' &&
    request.contactVerifiedAt !== null;

  return (
    <section aria-labelledby="recovery-heading" className="mt-6">
      <h2 id="recovery-heading" className="text-lg font-medium text-neutral-900">
        {t('recoveryDetailHeading')}
      </h2>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge label={t(`recoveryStatus.${request.status}`)} />
        <Badge label={t(`channel.${request.claimedContactChannel}`)} />
      </div>

      <dl
        aria-label={t('recoveryFacts')}
        className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3"
      >
        <Cell label={t('openedLabel')} value={minute(request.createdAt)} />
        <Cell label={t('expiresLabel')} value={minute(request.expiresAt)} />
        <Cell label={t('matchedLabel')} value={request.matchedAnAccount ? t('yes') : t('no')} />
        {request.newContactChannel !== null && (
          <Cell
            label={t('newChannelLabel')}
            value={t(`channel.${request.newContactChannel}`)}
          />
        )}
        <Cell
          label={t('contactVerifiedLabel')}
          value={request.contactVerifiedAt === null ? t('no') : minute(request.contactVerifiedAt)}
        />
        {request.reviewedAt !== null && (
          <Cell label={t('reviewedAtLabel')} value={minute(request.reviewedAt)} />
        )}
        {request.approvedAt !== null && (
          <Cell label={t('approvedAtLabel')} value={minute(request.approvedAt)} />
        )}
        {request.completedAt !== null && (
          <Cell label={t('completedAtLabel')} value={minute(request.completedAt)} />
        )}
        {request.closedAt !== null && <Cell label={t('closedAtLabel')} value={minute(request.closedAt)} />}
      </dl>

      {request.reviewNote !== null && (
        <div className="mt-4 rounded-lg border border-neutral-200 p-4">
          <p className="text-xs text-neutral-600">{t('reviewNoteLabel')}</p>
          <p className="mt-1 max-w-prose text-sm text-neutral-900">{request.reviewNote}</p>
        </div>
      )}
      {request.rejectionReason !== null && (
        <div className="mt-4 rounded-lg border border-neutral-200 p-4">
          <p className="text-xs text-neutral-600">{t('rejectionReasonLabel')}</p>
          <p className="mt-1 max-w-prose text-sm text-neutral-900">{request.rejectionReason}</p>
        </div>
      )}

      {/*
        What completing it did, read back from the writer's own record. Nothing on this screen set any of
        these, and there is no control anywhere that could shorten the hold.
      */}
      {request.completedAt !== null && (
        <dl
          aria-label={t('recoveryEffects')}
          className="mt-4 grid gap-4 rounded-lg border border-neutral-200 p-4 text-sm sm:grid-cols-3"
        >
          <Cell
            label={t('sessionsRevokedLabel')}
            value={request.sessionsRevokedAt === null ? t('no') : minute(request.sessionsRevokedAt)}
          />
          <Cell
            label={t('mfaResetLabel')}
            value={request.mfaResetAt === null ? t('no') : minute(request.mfaResetAt)}
          />
          <Cell
            label={t('holdUntilLabel')}
            value={request.holdUntil === null ? t('no') : minute(request.holdUntil)}
          />
        </dl>
      )}

      {evidence.kind === 'ok' && evidence.data.items.length > 0 && (
        <section aria-labelledby="recovery-evidence" className="mt-8">
          <h3 id="recovery-evidence" className="text-base font-medium text-neutral-900">
            {t('evidenceHeading')}
          </h3>
          <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('evidenceIntro')}</p>
          <ul className="mt-3 space-y-2">
            {((evidence.data as RecoveryEvidenceResponse).items ?? []).map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap justify-between gap-3 rounded-lg border border-neutral-200 px-4 py-3 text-sm"
              >
                <span className="text-neutral-900">{t(`evidenceType.${item.evidenceType}`)}</span>
                <span className="text-neutral-600">
                  {item.originalFilename ?? t('unnamedFile')}
                  {item.byteSize === null ? '' : ` · ${Math.ceil(item.byteSize / 1024)} KB`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        Exactly one control is ever shipped, and only when the database would accept it. Each branch that
        offers nothing says which rule is in the way, so a colleague is not left clicking at a refusal.
      */}
      {request.isOwnRequest ? (
        <p role="status" className="mt-8 text-sm text-neutral-600">
          {t('ownRequestHint')}
        </p>
      ) : canReview ? (
        <RecoveryDecisionForm
          requestId={request.id}
          step="review"
          copy={{
            heading: t('reviewHeading'),
            intro: t('reviewIntro'),
            noteLabel: t('noteLabel'),
            noteHint: t('reviewNoteHint'),
            submit: t('reviewSubmit'),
            confirm: t('reviewConfirm'),
            cancel: t('cancel'),
            working: t('working'),
            failed: t('failed'),
            conflict: t('conflict'),
            signedOut: t('signedOut'),
          }}
        />
      ) : canDecide ? (
        <RecoveryDecisionForm
          requestId={request.id}
          step="decision"
          copy={{
            heading: t('decisionHeading'),
            intro: t('decisionIntro'),
            noteLabel: t('noteLabel'),
            noteHint: t('decisionNoteHint'),
            approve: t('approve'),
            reject: t('reject'),
            submit: t('decisionSubmit'),
            confirm: t('decisionConfirm'),
            cancel: t('cancel'),
            working: t('working'),
            failed: t('failed'),
            conflict: t('conflict'),
            needsAnother: t('needsAnother'),
            signedOut: t('signedOut'),
          }}
        />
      ) : canComplete ? (
        <RecoveryDecisionForm
          requestId={request.id}
          step="completion"
          copy={{
            heading: t('completionHeading'),
            intro: t('completionIntro'),
            mfaLabel: t('mfaWasResetLabel'),
            submit: t('completionSubmit'),
            confirm: t('completionConfirm'),
            cancel: t('cancel'),
            working: t('working'),
            failed: t('failed'),
            conflict: t('conflict'),
            signedOut: t('signedOut'),
          }}
        />
      ) : request.isTheReviewer && request.status === 'under_review' ? (
        <p role="status" className="mt-8 text-sm text-neutral-600">
          {t('isReviewerHint')}
        </p>
      ) : request.status === 'contact_verification' && request.contactVerifiedAt === null ? (
        <p role="status" className="mt-8 text-sm text-neutral-600">
          {t('awaitingContactHint')}
        </p>
      ) : (
        <p role="status" className="mt-8 text-sm text-neutral-600">
          {t('noStepHint')}
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The audit trail                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export async function AuditTrail({
  cursor,
  tableSchema,
  tableName,
  recordId,
}: {
  readonly cursor: string | null;
  readonly tableSchema: string | null;
  readonly tableName: string | null;
  readonly recordId: string | null;
}) {
  const t = await getTranslations('AdminOps');
  const result = await readAdminAudit(
    { cursor, tableSchema, tableName, recordId },
    { cookieHeader: await currentCookieHeader() },
  );

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const page = (result as { kind: 'ok'; data: AuditPageResponse }).data;

  if (page.items.length === 0) {
    return <Notice title={t('auditEmptyTitle')} body={t('auditEmptyBody')} />;
  }

  const filters = [
    tableSchema === null || tableName === null
      ? ''
      : `&tableSchema=${encodeURIComponent(tableSchema)}&tableName=${encodeURIComponent(tableName)}`,
    tableSchema === null || tableName === null || recordId === null
      ? ''
      : `&recordId=${encodeURIComponent(recordId)}`,
  ].join('');

  return (
    <>
      <ul className="mt-6 space-y-3">
        {page.items.map((row) => (
          <li key={row.id} className="rounded-lg border border-neutral-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="text-sm font-medium text-neutral-900">
                {row.tableSchema === null || row.tableName === null
                  ? t('unknownTable')
                  : `${row.tableSchema}.${row.tableName}`}
              </p>
              <div className="flex flex-wrap gap-2">
                <Badge label={t(`auditAction.${row.action}`)} />
                {row.isOwnAction && <Badge label={t('ownActionLabel')} />}
              </div>
            </div>

            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
              <Cell label={t('whenLabel')} value={minute(row.occurredAt)} />
              {row.actorType !== null && (
                <Cell label={t('actorTypeLabel')} value={t(`actorType.${row.actorType}`)} />
              )}
              {row.recordId !== null && <Cell label={t('recordLabel')} value={row.recordId} />}
            </dl>

            {/*
              The names of the columns that changed, and nothing else. There is no old or new value in the
              contract to render: those are whole-row JSON redacted per trigger, and putting them on a screen
              would expose every audited table's columns to anybody holding this one key.
            */}
            {row.changedColumns.length > 0 && (
              <p className="mt-3 text-sm text-neutral-700">
                <span className="text-xs text-neutral-600">{t('changedColumnsLabel')}: </span>
                {row.changedColumns.join(', ')}
              </p>
            )}
          </li>
        ))}
      </ul>
      {page.nextCursor !== null && (
        <NextPage
          href={adminPath(`/audit?cursor=${encodeURIComponent(page.nextCursor)}${filters}`)}
          label={t('nextPage')}
        />
      )}
    </>
  );
}
