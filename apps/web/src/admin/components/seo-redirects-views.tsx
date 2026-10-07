import { Heading } from '@repo/ui';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import type { SeoRedirect, SeoRedirectDetail } from '@repo/contracts';
import { readSeoRedirectDetail, readSeoRedirectList, type SeoRedirectsResult } from '../server/bff';
import { currentStaffSession } from '../server/current-staff';
import {
  SeoRedirectCreateForm,
  SeoRedirectEditForm,
  SeoRedirectSearchForm,
  SeoRedirectStateForm,
} from './seo-redirects-forms';
import { adminPath } from '../paths';

/**
 * The SEO redirect map section.
 *
 * **Every panel renders inside the page's `RequireStaff` gate**, so a colleague who may not open this section
 * receives a refusal and no data — not hidden data, no data.
 *
 * **The controls are rendered from the server's answer, not from a role.** `canManage` comes back on the detail
 * because reading and managing are separate seeded keys, and a reader who holds only the first sees the entry and no
 * form.
 *
 * **Nothing here decides a business rule.** Which addresses are legal, which status codes exist, how a chain is
 * followed and how far — all of it is the database's. These screens offer the actions and show the refusal in the
 * words the API sent.
 *
 * **The screens say what the map does not do.** LIVE PAGE WINS is stated on the list, because it is the single fact
 * an operator most needs in order to predict what an entry will do: an entry whose address is a live page redirects
 * nobody, and nothing on this screen will tell them so afterwards.
 */

const CARD = 'mt-6 rounded-lg border border-neutral-200 bg-white p-5';
const TABLE = 'mt-4 w-full border-collapse text-left text-sm';
const TH = 'border-b border-neutral-200 pb-2 pr-4 font-medium text-neutral-600';
const TD = 'border-b border-neutral-100 py-2 pr-4 align-top text-neutral-900';

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not a page of rows. */
async function problem<T>(result: SeoRedirectsResult<T>): Promise<string | null> {
  const t = await getTranslations('SeoRedirects');
  if (result.kind === 'ok') return null;
  if (result.kind === 'unauthenticated') return t('sessionExpired');
  if (result.kind === 'notFound') return t('notFoundBody');
  if (result.kind === 'invalid') return t('cursorBody');
  return t('unavailable');
}

function Message({ tone, title, body }: { tone: 'empty' | 'error'; title: string; body: string }) {
  return (
    <div
      className={`mt-4 rounded-md border p-4 ${
        tone === 'error' ? 'border-red-200 bg-red-50' : 'border-neutral-200 bg-neutral-50'
      }`}
    >
      <p className="font-medium text-neutral-900">{title}</p>
      <p className="mt-1 text-sm text-neutral-700">{body}</p>
    </div>
  );
}

/** The query a page link must keep, so paging does not silently drop a filter. */
function carried(search: string | null, active: string | null): string {
  const params = new URLSearchParams();
  if (search !== null && search !== '') params.set('search', search);
  if (active === 'true' || active === 'false') params.set('active', active);
  return params.toString();
}

/* ------------------------------------------------------------------------------------------------ */
/* The list                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface SeoRedirectListProps {
  readonly cursor: string | null;
  readonly search: string | null;
  readonly active: string | null;
}

export async function SeoRedirectList({ cursor, search, active }: SeoRedirectListProps) {
  const t = await getTranslations('SeoRedirects');
  const result = await readSeoRedirectList({ cursor, search, active }, { cookieHeader: await cookieHeader() });
  const failure = await problem(result);

  if (failure !== null || result.kind !== 'ok') {
    return (
      <section className={CARD}>
        <Heading level={2}>{t('listHeading')}</Heading>
        <Message tone="error" title={t('unavailableTitle')} body={failure ?? t('unavailable')} />
      </section>
    );
  }

  const { items, nextCursor } = result.data;
  const keep = carried(search, active);

  return (
    <section className={CARD}>
      <Heading level={2}>{t('listHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('listIntro')}</p>
      {/* Said out loud, because an operator cannot deduce it from anything on the screen and a surprise here is a
          redirect that appears to do nothing. */}
      <Message tone="empty" title={t('precedenceTitle')} body={t('precedenceBody')} />

      <SeoRedirectSearchForm
        initial={{ search, active }}
        copy={{
          searchLabel: t('searchLabel'),
          searchHint: t('searchHint'),
          stateLabel: t('stateLabel'),
          stateAny: t('stateAny'),
          stateActive: t('stateActive'),
          stateInactive: t('stateInactive'),
          submit: t('searchSubmit'),
          clear: t('searchClear'),
        }}
      />

      {items.length === 0 ? (
        <Message
          tone="empty"
          title={search === null && active === null ? t('emptyTitle') : t('noMatchesTitle')}
          body={search === null && active === null ? t('emptyBody') : t('noMatchesBody')}
        />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnFrom')}</th>
              <th className={TH}>{t('columnTo')}</th>
              <th className={TH}>{t('columnStatus')}</th>
              <th className={TH}>{t('columnState')}</th>
              <th className={TH}>{t('columnNote')}</th>
              <th className={TH}>{t('columnUpdated')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((redirect) => (
              <SeoRedirectRow
                key={redirect.id}
                redirect={redirect}
                activeLabel={t('stateActive')}
                inactiveLabel={t('stateInactive')}
              />
            ))}
          </tbody>
        </table>
      )}

      {nextCursor === null ? null : (
        <p className="mt-4">
          <Link
            className="text-sm text-neutral-900 underline"
            href={`/seo/redirects?cursor=${encodeURIComponent(nextCursor)}${keep === '' ? '' : `&${keep}`}`}
          >
            {t('nextPage')}
          </Link>
        </p>
      )}
    </section>
  );
}

function SeoRedirectRow({
  redirect,
  activeLabel,
  inactiveLabel,
}: {
  readonly redirect: SeoRedirect;
  readonly activeLabel: string;
  readonly inactiveLabel: string;
}) {
  return (
    <tr>
      <td className={TD}>
        <Link className="text-neutral-900 underline" href={adminPath(`/seo/redirects/${redirect.id}`)}>
          <code>{redirect.fromPath}</code>
        </Link>
      </td>
      <td className={TD}>
        <code>{redirect.toPath}</code>
      </td>
      <td className={TD}>{redirect.statusCode}</td>
      <td className={TD}>{redirect.isActive ? activeLabel : inactiveLabel}</td>
      <td className={TD}>{redirect.note ?? '—'}</td>
      <td className={TD}>
        <time dateTime={redirect.updatedAt}>{redirect.updatedAt.slice(0, 10)}</time>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Creating                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Adding an entry needs `seo.redirect.manage`, which is a different key from the one that opens this section.
 *
 * The list response carries no capability flag — only the detail does, because that is where a console needs it per
 * entry — so this panel asks the session the same way the page's own gate does. A colleague holding only
 * `seo.redirect.read` gets **no panel at all**, not a disabled one.
 */
export async function SeoRedirectCreatePanel() {
  const t = await getTranslations('SeoRedirects');
  const session = await currentStaffSession();
  if (session.kind !== 'ok' || !session.session.permissions.includes('seo.redirect.manage')) return null;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('createHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('createIntro')}</p>
      <SeoRedirectCreateForm
        copy={{
          fromLabel: t('fromLabel'),
          fromHint: t('fromHint'),
          toLabel: t('toLabel'),
          toHint: t('toHint'),
          statusLabel: t('statusLabel'),
          statusHint: t('statusHint'),
          noteLabel: t('noteLabel'),
          activeLabel: t('activeLabel'),
          activeHint: t('activeHint'),
          submit: t('createSubmit'),
          working: t('working'),
          failed: t('createFailed'),
          pathTaken: t('pathTaken'),
          notAllowed: t('notAllowed'),
          invalid: t('invalid'),
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One entry                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export async function SeoRedirectDetailView({ redirectId }: { readonly redirectId: string | undefined }) {
  const t = await getTranslations('SeoRedirects');
  const result = await readSeoRedirectDetail(redirectId, { cookieHeader: await cookieHeader() });

  if (result.kind !== 'ok') {
    const failure = await problem(result);
    return (
      <section className={CARD}>
        <Heading level={2}>{t('detailHeading')}</Heading>
        <Message
          tone={result.kind === 'notFound' ? 'empty' : 'error'}
          title={result.kind === 'notFound' ? t('notFoundTitle') : t('unavailableTitle')}
          body={failure ?? t('unavailable')}
        />
      </section>
    );
  }

  const redirect = result.data;

  return (
    <>
      <section className={CARD}>
        <Heading level={2}>{redirect.fromPath}</Heading>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-600">{t('columnTo')}</dt>
          <dd className="text-neutral-900">
            <code>{redirect.toPath}</code>
          </dd>
          <dt className="text-neutral-600">{t('columnStatus')}</dt>
          <dd className="text-neutral-900">{redirect.statusCode}</dd>
          <dt className="text-neutral-600">{t('columnState')}</dt>
          <dd className="text-neutral-900">{redirect.isActive ? t('stateActive') : t('stateInactive')}</dd>
          <dt className="text-neutral-600">{t('columnNote')}</dt>
          <dd className="text-neutral-900">{redirect.note ?? '—'}</dd>
          <dt className="text-neutral-600">{t('resolvedLabel')}</dt>
          <dd className="text-neutral-900">
            {redirect.resolvedToPath === null ? (
              t('resolvedNone')
            ) : (
              <code>
                {redirect.resolvedToPath} ({redirect.resolvedStatusCode})
              </code>
            )}
          </dd>
          <dt className="text-neutral-600">{t('columnUpdated')}</dt>
          <dd className="text-neutral-900">
            <time dateTime={redirect.updatedAt}>{redirect.updatedAt}</time>
          </dd>
        </dl>

        {redirect.resolvedToPath !== null && redirect.resolvedToPath !== redirect.toPath ? (
          // The destination is itself redirected onwards. Worth saying, because a visitor takes two hops where the
          // operator wrote one, and the chain is only visible from here.
          <Message tone="empty" title={t('chainTitle')} body={t('chainBody')} />
        ) : null}

        {redirect.isActive && redirect.resolvedToPath === null ? (
          // Active and resolving to nothing means the chain comes back to where it started. 0030's resolver stops
          // rather than looping and the public reader answers nothing, so the entry is live and does nothing.
          <Message tone="error" title={t('loopTitle')} body={t('loopBody')} />
        ) : null}

        {redirect.canManage ? null : <Message tone="empty" title={t('readOnlyTitle')} body={t('readOnlyBody')} />}
      </section>

      {redirect.canManage ? <SeoRedirectControls redirect={redirect} /> : null}
    </>
  );
}

async function SeoRedirectControls({ redirect }: { readonly redirect: SeoRedirectDetail }) {
  const t = await getTranslations('SeoRedirects');
  return (
    <>
      <section className={CARD}>
        <Heading level={2}>{t('editHeading')}</Heading>
        <SeoRedirectEditForm
          redirectId={redirect.id}
          initial={{
            fromPath: redirect.fromPath,
            toPath: redirect.toPath,
            statusCode: redirect.statusCode,
            note: redirect.note,
          }}
          copy={{
            fromLabel: t('fromLabel'),
            fromHint: t('fromRenameHint'),
            toLabel: t('toLabel'),
            toHint: t('toHint'),
            statusLabel: t('statusLabel'),
            statusHint: t('statusHint'),
            noteLabel: t('noteLabel'),
            noteHint: t('noteClearHint'),
            submit: t('editSubmit'),
            working: t('working'),
            failed: t('editFailed'),
            pathTaken: t('pathTaken'),
            notAllowed: t('notAllowed'),
            invalid: t('invalid'),
          }}
        />
      </section>

      <section className={CARD}>
        <Heading level={2}>{t('stateHeading')}</Heading>
        <p className="mt-1 text-sm text-neutral-600">{t('stateIntro')}</p>
        <SeoRedirectStateForm
          redirectId={redirect.id}
          isActive={redirect.isActive}
          copy={{
            // One label, and the one confirmation that goes with it. Switching off needs no confirmation — it stops
            // a redirect, which is the safe direction — so its sentence is empty and the form asks nothing.
            toggle: redirect.isActive ? t('deactivate') : t('activate'),
            toggleConfirm: redirect.isActive ? '' : t('activateConfirm'),
            remove: t('remove'),
            removeConfirm: t('removeConfirm'),
            working: t('working'),
            failed: t('stateFailed'),
            invalid: t('invalid'),
          }}
        />
      </section>
    </>
  );
}
