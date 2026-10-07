import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { CONSOLE_SECTIONS, sectionsFor } from '../server/console-sections';
import { currentStaffSession } from '../server/current-staff';
import { AdminNav } from './admin-nav';
import { LocaleSwitch } from './locale-switch';
import { adminPath } from '../paths';

/**
 * The server-side gate every protected console page renders inside (Phase 7-F).
 *
 * **Why this is a component and not a layout.** A layout that refuses to render `children` hides the
 * page from the document and nothing more: Next.js renders the page segment independently, so its
 * output still reaches the browser inside the streamed RSC payload. That was measured on the public app
 * in Phase 5-A — a first version of its gate lived in a layout, and the protection test found the whole
 * settings page in the flight data of a signed-out response — and it is the reason the same shape is
 * used here. For a settings page that was copy; for a console section it would be somebody else's
 * moderation queue.
 *
 * A server component inside the page does not have that problem. `children` is a React element that is
 * only *invoked* if this component returns it, so when the answer is "not allowed" the protected
 * subtree is never rendered, never serialized and never sent. A protected page therefore has one rule:
 * build nothing outside this wrapper.
 *
 * **The three checks, in this order, and all three on the server.**
 *
 *   1. **A session.** No admin cookie, a forged one, an expired one, a revoked one and a deleted
 *      account all arrive here and all get the same signed-out view.
 *   2. **AAL2.** Staff who have not completed a second factor hold *no* effective permissions — the
 *      database applied that rule, so there is nothing to check here beyond routing them to the
 *      existing 7-B challenge. Nothing on this path can substitute for completing it.
 *   3. **The permission.** A page names the key it needs; the shell asks whether the effective set the
 *      database reported contains it. The set is never sent by a browser and never widened here.
 *
 * **One refusal for everybody who may not be here.** A buyer, a seller, a signed-in stranger and a
 * moderator who opened the support section by typing its address all receive the same neutral page. It
 * names no permission, no role and no section, because telling somebody which key they are missing is
 * telling them what exists and what to go and get. Staff who need to step up are the one distinguished
 * case, because that is a fact about their own account which they already know and must act on.
 *
 * **An unreachable API is a third case.** It is not a refusal — the person may be perfectly entitled —
 * so it says so and offers no sign-in link that would be a lie.
 */
export async function RequireStaff({
  permission,
  children,
}: {
  /** The seeded permission key this page requires. Omitted only by the console home. */
  readonly permission?: string;
  readonly children: ReactNode;
}) {
  const [locale, t, result] = await Promise.all([
    getLocale(),
    getTranslations('Console'),
    currentStaffSession(),
  ]);

  if (result.kind === 'unavailable') {
    return (
      <Refusal title={t('unavailableTitle')} body={t('unavailableBody')} />
    );
  }

  if (result.kind === 'unauthenticated') {
    return (
      <Refusal title={t('signedOutTitle')} body={t('signedOutBody')}>
        <Link
          href={adminPath('/login')}
          className="mt-6 inline-block rounded-md border border-neutral-300 px-4 py-2 text-sm"
        >
          {t('signIn')}
        </Link>
      </Refusal>
    );
  }

  const session = result.session;

  // Staff who are signed in but have not reached aal2. Distinguished on purpose: they can act on it.
  if (session.isStaff && session.requiresStepUp) {
    return (
      <Refusal title={t('stepUpTitle')} body={t('stepUpBody')}>
        <Link
          href={adminPath('/security/totp')}
          className="mt-6 inline-block rounded-md border border-neutral-300 px-4 py-2 text-sm"
        >
          {t('stepUp')}
        </Link>
      </Refusal>
    );
  }

  // Everybody else who may not be here gets one answer. Not staff, staff without this permission, and
  // a signed-in buyer are indistinguishable from each other in what comes back.
  const allowed =
    session.isStaff &&
    (permission === undefined
      ? session.permissions.length > 0
      : session.permissions.includes(permission));

  if (!allowed) {
    return <Refusal title={t('forbiddenTitle')} body={t('forbiddenBody')} />;
  }

  const sections = sectionsFor(session.permissions);
  const sectionLabels = await getTranslations('Sections');

  return (
    <>
      <ConsoleHeader
        locale={locale as Locale}
        name={session.displayName}
        roleLabel={session.roles.map((role) => sectionLabels(`role.${role}`)).join(' · ')}
      />
      <AdminNav
        label={t('sectionsLabel')}
        menuLabel={t('menu')}
        items={sections.map((section) => ({
          // `console-sections.ts` declares console-relative addresses — `/catalog`, `/users` — and this is the one
          // place that turns them into browser addresses (0108). The registry stays a statement about the console's
          // own shape rather than about where the console happens to be mounted.
          href: adminPath(section.href),
          label: sectionLabels(`${section.id}.title`),
        }))}
      />
      {children}
    </>
  );
}

/** The account area and the language switch. Rendered only for somebody who is allowed to be here. */
async function ConsoleHeader({
  locale,
  name,
  roleLabel,
}: {
  readonly locale: Locale;
  readonly name: string | null;
  readonly roleLabel: string;
}) {
  const t = await getTranslations('Console');
  return (
    <div className="border-b border-neutral-200 bg-neutral-50">
      <PageContainer>
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          <p className="text-sm text-neutral-700">
            <span className="font-medium text-neutral-900">{name ?? t('accountUnnamed')}</span>
            {roleLabel !== '' && <span className="ms-2 text-neutral-600">{roleLabel}</span>}
          </p>
          <LocaleSwitch
            current={locale === 'ar' ? 'ar' : 'en'}
            labels={{
              label: t('language'),
              english: 'English',
              arabic: 'العربية',
              working: t('working'),
              failed: t('languageFailed'),
            }}
          />
        </div>
      </PageContainer>
    </div>
  );
}

/** Every state that is not "render the page", in one shape. */
function Refusal({
  title,
  body,
  children,
}: {
  readonly title: string;
  readonly body: string;
  readonly children?: ReactNode;
}) {
  return (
    <PageContainer>
      <div className="py-12" role="status">
        <Heading level={1}>{title}</Heading>
        <p className="mt-4 max-w-prose text-neutral-600">{body}</p>
        {children}
      </div>
    </PageContainer>
  );
}

/** The number of sections the console knows about. Used by the home page's own copy. */
export const CONSOLE_SECTION_COUNT = CONSOLE_SECTIONS.length;
