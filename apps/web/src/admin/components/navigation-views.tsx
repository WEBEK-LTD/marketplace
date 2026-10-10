import { Heading } from '@repo/ui';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { isCmsPageSlug } from '@repo/config';
import type { NavigationItem, NavigationTargetKind } from '@repo/contracts';
import { readNavigationMenu, readNavigationMenus, type NavigationResult } from '../server/bff';
import {
  NavigationBackLink,
  NavigationItemControls,
  NavigationItemCreateForm,
  NavigationMenuCreateForm,
  NavigationMenuEditForm,
  NavigationMenuStateForm,
  NavigationReorderForm,
} from './navigation-forms';
import { adminPath } from '../paths';

/**
 * The navigation section (0094).
 *
 * **Every panel renders inside the page's `RequireStaff` gate**, so a colleague who may not open this section
 * receives a refusal and no data.
 *
 * **The controls are rendered from the server's answer, not from a role.** `canManage` comes back on the list and
 * on the detail, because reading and arranging are separate seeded keys.
 *
 * **Three things an operator could not otherwise work out are said out loud.** A menu the site does not place is
 * marked and explained. An entry whose target is no longer public is marked, with which of the two it is, because
 * the public site drops it silently and this is the only place the reason exists. And an entry pointing at a page
 * the application does not serve at that address — owner decision 4 — is marked here, because the public site
 * simply omits it and nothing else would ever say so.
 */

const CARD = 'mt-6 rounded-lg border border-hairline bg-surface-raised p-5';
const TABLE = 'mt-4 w-full border-collapse text-left text-sm';
const TH = 'border-b border-hairline pb-2 pr-4 font-medium text-ink-muted';
const TD = 'border-b border-hairline py-2 pr-4 align-top text-ink-strong';

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not data. */
async function problem<T>(result: NavigationResult<T>): Promise<string | null> {
  const t = await getTranslations('Navigation');
  if (result.kind === 'ok') return null;
  if (result.kind === 'unauthenticated') return t('sessionExpired');
  if (result.kind === 'notFound') return t('notFoundBody');
  if (result.kind === 'invalid') return t('invalid');
  return t('unavailable');
}

function Message({ tone, title, body }: { tone: 'empty' | 'error'; title: string; body: string }) {
  return (
    <div
      className={`mt-4 rounded-md border p-4 ${
        tone === 'error' ? 'border-red-200 bg-red-50' : 'border-hairline bg-surface-sunken'
      }`}
    >
      <p className="font-medium text-ink-strong">{title}</p>
      <p className="mt-1 text-sm text-ink-body">{body}</p>
    </div>
  );
}

/**
 * Whether this entry points at an address the public site actually serves.
 *
 * Owner decision 4, reported where it can be reported: a page may be published and still sit outside the closed
 * set of addresses this application serves, in which case the public navigation omits the entry. The route map
 * lives in `@repo/config`, which is why this check is here and not in the database.
 */
function isUnservable(item: NavigationItem): boolean {
  return item.targetKind === 'page' && item.targetSlug !== null && !isCmsPageSlug(item.targetSlug);
}

/* ------------------------------------------------------------------------------------------------ */
/* The list                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export async function NavigationMenuList() {
  const t = await getTranslations('Navigation');
  const result = await readNavigationMenus({ cookieHeader: await cookieHeader() });
  const failure = await problem(result);

  if (failure !== null || result.kind !== 'ok') {
    return (
      <section className={CARD}>
        <Heading level={2}>{t('listHeading')}</Heading>
        <Message tone="error" title={t('unavailableTitle')} body={failure ?? t('unavailable')} />
      </section>
    );
  }

  const { menus } = result.data;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('listHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('listIntro')}</p>
      {/* Said out loud, because an operator cannot deduce any of it from anything on the screen. */}
      <Message tone="empty" title={t('notHereTitle')} body={t('notHereBody')} />

      {menus.length === 0 ? (
        <Message tone="empty" title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnKey')}</th>
              <th className={TH}>{t('columnLabel')}</th>
              <th className={TH}>{t('columnVisible')}</th>
              <th className={TH}>{t('columnEntries')}</th>
              <th className={TH}>{t('columnNotes')}</th>
              <th className={TH}>{t('columnUpdated')}</th>
            </tr>
          </thead>
          <tbody>
            {menus.map((menu) => (
              <tr key={menu.id}>
                <td className={TD}>
                  <Link className="text-ink-strong underline" href={adminPath(`/cms/navigation/${menu.id}`)}>
                    <code>{menu.menuKey}</code>
                  </Link>
                </td>
                <td className={TD}>{menu.labelEn}</td>
                <td className={TD}>{menu.isActive ? t('shown') : t('hidden')}</td>
                <td className={TD}>
                  {t('entriesCount', { total: menu.itemCount, renderable: menu.renderableItemCount })}
                </td>
                <td className={TD}>
                  {/* Two states an operator would otherwise have to discover from the live site. */}
                  {!menu.isServed ? <p className="text-amber-700">{t('notPlaced')}</p> : null}
                  {menu.isServed && menu.isActive && menu.renderableItemCount === 0 ? (
                    <p className="text-red-700">{t('nothingToShow')}</p>
                  ) : null}
                  {menu.isServed && !(menu.isActive && menu.renderableItemCount === 0) ? '—' : null}
                </td>
                <td className={TD}>
                  <time dateTime={menu.updatedAt}>{menu.updatedAt.slice(0, 10)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Adding a menu                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Adding a menu needs `cms.navigation.manage`, a different key from the one that opens this section.
 *
 * The capability comes from the list response, which this panel reads anyway. A colleague holding only the read key
 * gets **no panel at all**, not a disabled one.
 */
export async function NavigationAddPanel() {
  const t = await getTranslations('Navigation');
  const result = await readNavigationMenus({ cookieHeader: await cookieHeader() });
  if (result.kind !== 'ok' || !result.data.canManage) return null;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('addHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('addIntro')}</p>
      <NavigationMenuCreateForm
        copy={{
          keyLabel: t('keyLabel'),
          keyHint: t('keyHint'),
          labelEnLabel: t('labelEnLabel'),
          labelArLabel: t('labelArLabel'),
          submit: t('saveSubmit'),
          failed: t('saveFailed'),
          invalid: t('invalid'),
          keyTaken: t('keyTaken'),
          notAllowed: t('notAllowed'),
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One menu                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export async function NavigationMenuDetailView({ menuId }: { readonly menuId: string | undefined }) {
  const t = await getTranslations('Navigation');
  const locale = await getLocale();
  const result = await readNavigationMenu(menuId, locale, { cookieHeader: await cookieHeader() });
  const failure = await problem(result);

  if (failure !== null || result.kind !== 'ok') {
    return (
      <section className={CARD}>
        <Heading level={2}>{t('detailHeading')}</Heading>
        <p className="mt-2 text-sm">
          <NavigationBackLink label={t('backToList')} />
        </p>
        <Message
          tone="error"
          title={result.kind === 'notFound' ? t('notFoundTitle') : t('unavailableTitle')}
          body={failure ?? t('unavailable')}
        />
      </section>
    );
  }

  const menu = result.data;
  const parents = menu.items.filter((item) => item.parentId === null);
  const childrenOf = (parentId: string): readonly NavigationItem[] =>
    menu.items.filter((item) => item.parentId === parentId);

  const kindNames: Readonly<Record<NavigationTargetKind, string>> = {
    page: t('kindPage'),
    blog_post: t('kindBlogPost'),
    category: t('kindCategory'),
    path: t('kindPath'),
  };

  const targetCopy = {
    kindLabel: t('kindLabel'),
    kindHint: t('kindHint'),
    pageIdLabel: t('pageIdLabel'),
    blogPostIdLabel: t('blogPostIdLabel'),
    categoryIdLabel: t('categoryIdLabel'),
    pathLabel: t('pathLabel'),
    pathHint: t('pathHint'),
    kindNames,
  } as const;

  // Two copies rather than one flag: the word for promoting an entry is only sent for a row that can be promoted,
  // because a client component's whole props object is serialised into the RSC payload and a label for a button
  // that never renders would still be in the page's source.
  const rowCopy = {
    ...targetCopy,
    labelEnLabel: t('labelEnLabel'),
    labelArLabel: t('labelArLabel'),
    newTabLabel: t('newTabLabel'),
    sortOrderLabel: t('sortOrderLabel'),
    save: t('saveSubmit'),
    toggle: t('toggleEntry'),
    remove: t('removeEntry'),
    removeConfirm: t('removeEntryConfirm'),
    failed: t('saveFailed'),
    invalid: t('invalid'),
    notAllowed: t('notAllowed'),
    unknownReference: t('unknownReference'),
    targetInvalid: t('targetInvalid'),
  } as const;

  const childRowCopy = { ...rowCopy, promote: t('promote') } as const;

  return (
    <>
      <section className={CARD}>
        <Heading level={2}>{t('detailHeading')}</Heading>
        <p className="mt-2 text-sm">
          <NavigationBackLink label={t('backToList')} />
        </p>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <Row label={t('columnKey')} value={<code>{menu.menuKey}</code>} />
          <Row label={t('columnLabel')} value={menu.labelEn} />
          <Row label={t('columnVisible')} value={menu.isActive ? t('shown') : t('hidden')} />
          <Row
            label={t('columnEntries')}
            value={t('entriesCount', { total: menu.itemCount, renderable: menu.renderableItemCount })}
          />
          <Row label={t('columnUpdated')} value={<time dateTime={menu.updatedAt}>{menu.updatedAt}</time>} />
        </dl>

        {!menu.isServed ? <Message tone="empty" title={t('notPlaced')} body={t('notPlacedBody')} /> : null}
        {menu.isServed && menu.isActive && menu.renderableItemCount === 0 ? (
          <Message tone="error" title={t('nothingToShow')} body={t('nothingToShowBody')} />
        ) : null}

        {/* Decided on the server, not inside the form: a client component's whole props object is serialised into
            the RSC payload, so rendering a control and letting it return null would still put its words in the
            page's own source. */}
        {menu.canManage ? (
          <>
            <NavigationMenuEditForm
              copy={{
                keyLabel: t('keyLabel'),
                keyHint: t('keyHint'),
                labelEnLabel: t('labelEnLabel'),
                labelArLabel: t('labelArLabel'),
                clearArabic: t('clearArabic'),
                submit: t('saveSubmit'),
                failed: t('saveFailed'),
                invalid: t('invalid'),
                keyTaken: t('keyTaken'),
                notAllowed: t('notAllowed'),
              }}
              labelAr={menu.labelAr}
              labelEn={menu.labelEn}
              menuId={menu.id}
              menuKey={menu.menuKey}
            />
            <NavigationMenuStateForm
              copy={{
                toggle: menu.isActive ? t('hideMenu') : t('showMenu'),
                remove: t('removeMenu'),
                removeConfirm: t('removeMenuConfirm'),
                failed: t('saveFailed'),
                invalid: t('invalid'),
              }}
              isActive={menu.isActive}
              menuId={menu.id}
            />
          </>
        ) : null}
      </section>

      <section className={CARD}>
        <Heading level={2}>{t('entriesHeading')}</Heading>
        <p className="mt-1 text-sm text-ink-muted">{t('entriesIntro')}</p>

        {menu.items.length === 0 ? (
          <Message tone="empty" title={t('noEntriesTitle')} body={t('noEntriesBody')} />
        ) : (
          <ul className="mt-4 space-y-6">
            {parents.map((parent) => (
              <li className="rounded-md border border-hairline p-4" key={parent.id}>
                <EntryHeader item={parent} />
                {menu.canManage ? (
                  <div className="mt-3">
                    <NavigationItemControls
                      blogPostId={parent.blogPostId}
                      categoryId={parent.categoryId}
                      copy={rowCopy}
                      isActive={parent.isActive}
                      itemId={parent.id}
                      labelAr={parent.labelAr}
                      labelEn={parent.labelEn}
                      opensInNewTab={parent.opensInNewTab}
                      pageId={parent.pageId}
                      path={parent.path}
                      sortOrder={parent.sortOrder}
                      targetKind={parent.targetKind}
                    />
                  </div>
                ) : null}

                {childrenOf(parent.id).length === 0 ? null : (
                  <ul className="mt-4 space-y-4 border-l border-hairline pl-4">
                    {childrenOf(parent.id).map((child) => (
                      <li key={child.id}>
                        <EntryHeader item={child} />
                        {menu.canManage ? (
                          <div className="mt-3">
                            <NavigationItemControls
                              blogPostId={child.blogPostId}
                              categoryId={child.categoryId}
                              copy={childRowCopy}
                              isActive={child.isActive}
                              itemId={child.id}
                              labelAr={child.labelAr}
                              labelEn={child.labelEn}
                              opensInNewTab={child.opensInNewTab}
                              pageId={child.pageId}
                              path={child.path}
                              sortOrder={child.sortOrder}
                              targetKind={child.targetKind}
                            />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Fewer than two entries at the top level means there is no order to change and no words for one. */}
        {!menu.canManage || parents.length < 2 ? null : (
          <NavigationReorderForm
            copy={{
              heading: t('reorderHeading'),
              hint: t('reorderHint'),
              up: t('moveUp'),
              down: t('moveDown'),
              submit: t('reorderSubmit'),
              failed: t('saveFailed'),
              invalid: t('invalid'),
            }}
            items={parents.map((item) => ({ id: item.id, label: item.labelEn }))}
            menuId={menu.id}
          />
        )}
      </section>

      {menu.canManage ? (
        <section className={CARD}>
          <Heading level={2}>{t('addEntryHeading')}</Heading>
          <p className="mt-1 text-sm text-ink-muted">{t('addEntryIntro')}</p>
          <NavigationItemCreateForm
            copy={{
              ...targetCopy,
              labelEnLabel: t('labelEnLabel'),
              labelArLabel: t('labelArLabel'),
              parentLabel: t('parentLabel'),
              parentNone: t('parentNone'),
              parentHint: t('parentHint'),
              newTabLabel: t('newTabLabel'),
              sortOrderLabel: t('sortOrderLabel'),
              submit: t('saveSubmit'),
              failed: t('saveFailed'),
              invalid: t('invalid'),
              notAllowed: t('notAllowed'),
              unknownReference: t('unknownReference'),
              targetInvalid: t('targetInvalid'),
            }}
            menuId={menu.id}
            parents={parents.map((item) => ({ id: item.id, label: item.labelEn }))}
          />
        </section>
      ) : null}
    </>
  );
}

/** One entry's own facts: what it says, where it points, and whether the public is being shown it. */
async function EntryHeader({ item }: { readonly item: NavigationItem }) {
  const t = await getTranslations('Navigation');
  const unservable = isUnservable(item);

  return (
    <div>
      <p className="font-medium text-ink-strong">{item.labelEn}</p>
      <p className="mt-1 text-xs text-ink-muted">
        <code>{item.targetKind}</code>
        {item.targetSlug === null ? null : <> · {item.targetSlug}</>}
        {item.path === null ? null : <> · {item.path}</>}
        {item.targetTitle === null ? null : <> · {item.targetTitle}</>}
      </p>
      <p className="mt-1 text-xs">
        <span className="text-ink-body">{item.isActive ? t('shown') : t('hidden')}</span>
        {item.opensInNewTab ? <span className="text-ink-body"> · {t('newTabLabel')}</span> : null}
        {item.targetState === 'not_public' ? (
          <span className="text-amber-700"> · {t('targetNotPublic')}</span>
        ) : null}
        {item.targetState === 'missing' ? <span className="text-red-700"> · {t('targetMissing')}</span> : null}
        {/* Owner decision 4: published, and still at an address this application does not serve. */}
        {unservable ? <span className="text-amber-700"> · {t('targetUnservable')}</span> : null}
      </p>
    </div>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-ink-strong">{value}</dd>
    </div>
  );
}
