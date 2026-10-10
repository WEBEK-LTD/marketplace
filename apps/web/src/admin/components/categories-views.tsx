import { publicCategoryPath } from '@repo/config';
import { Heading } from '@repo/ui';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import type { AdminCategoryDetailResponse, AdminCategoryNode } from '@repo/contracts';
import { readCategoryDetail, readCategoryTree, type CategoriesResult } from '../server/bff';
import { currentStaffSession } from '../server/current-staff';
import {
  CategoryCreateForm,
  CategorySettingsForm,
  CategoryStateForm,
  CategoryTranslationForm,
} from './categories-forms';
import { adminPath } from '../paths';

/**
 * The category tree section.
 *
 * **Every panel renders inside the page's `RequireStaff` gate**, so a colleague who may not open this section
 * receives a refusal and no data — not hidden data, no data.
 *
 * **The controls are rendered from the server's answer, not from a role.** `canManage` comes back on the detail
 * because reading and managing are separate seeded keys, and a reader who holds only the first sees the tree and
 * no form. Deciding that here from a role name would be a second, weaker copy of a rule the database applies.
 *
 * **The tree is shown whole, including the hidden.** A console that listed only what the public can see could not
 * be used to bring a category back, and `isVisible` is carried per row so the one state a row cannot report about
 * itself — active, but under a hidden ancestor — is said out loud.
 *
 * **There is no rename control and no delete control**, because there are no such routes: the slug is a public
 * address with no history to redirect from, and every table that references a category restricts deletion.
 */

const CARD = 'mt-6 rounded-lg border border-hairline bg-surface-raised p-5';
const TABLE = 'mt-4 w-full border-collapse text-left text-sm';
const TH = 'border-b border-hairline pb-2 pr-4 font-medium text-ink-muted';
const TD = 'border-b border-hairline py-2 pr-4 align-top text-ink-strong';

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not data. */
async function problem<T>(result: CategoriesResult<T>): Promise<string | null> {
  const t = await getTranslations('Categories');
  if (result.kind === 'ok') return null;
  if (result.kind === 'unauthenticated') return t('sessionExpired');
  if (result.kind === 'notFound') return t('notFoundBody');
  if (result.kind === 'invalid') return t('invalidBody');
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

/** Whether this caller holds the manage key. Asked once, used to decide whether a control exists at all. */
async function canManage(): Promise<boolean> {
  const session = await currentStaffSession();
  return session.kind === 'ok' && session.session.permissions.includes('catalog.category.manage');
}

/* ------------------------------------------------------------------------------------------------ */
/* The tree                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export async function CategoryTree() {
  const t = await getTranslations('Categories');
  const result = await readCategoryTree({ cookieHeader: await cookieHeader() });

  if (result.kind !== 'ok') {
    const failure = await problem(result);
    return (
      <section className={CARD}>
        <Heading level={2}>{t('treeHeading')}</Heading>
        <Message
          tone={result.kind === 'notFound' ? 'empty' : 'error'}
          title={result.kind === 'notFound' ? t('notFoundTitle') : t('unavailableTitle')}
          body={failure ?? t('unavailable')}
        />
      </section>
    );
  }

  const { categories } = result.data;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('treeHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('treeNote')}</p>

      {categories.length === 0 ? (
        <Message tone="empty" title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnName')}</th>
              <th className={TH}>{t('columnDepth')}</th>
              <th className={TH}>{t('columnOrder')}</th>
              <th className={TH}>{t('columnState')}</th>
              <th className={TH}>{t('columnLocales')}</th>
              <th className={TH}>{t('columnContents')}</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => (
              <CategoryRow key={category.categoryId} category={category} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

async function CategoryRow({ category }: { readonly category: AdminCategoryNode }) {
  const t = await getTranslations('Categories');

  // Depth is indentation. The tree arrives in depth order, so one row per line is already a readable tree.
  const indent = category.depth === 0 ? '' : category.depth === 1 ? 'pl-5' : 'pl-10';

  return (
    <tr>
      <td className={TD}>
        <span className={indent}>
          <Link className="underline hover:no-underline" href={adminPath(`/catalog/categories/${category.categoryId}`)}>
            {category.name ?? category.slug}
          </Link>
        </span>
        <span className="mt-1 block text-xs text-ink-muted">
          <code>{publicCategoryPath('en', category.slug)}</code>
        </span>
      </td>
      <td className={TD}>{category.depth + 1}</td>
      <td className={TD}>{category.sortOrder}</td>
      <td className={TD}>
        {category.isActive ? t('stateShown') : t('stateHidden')}
        {/* The one thing a row cannot say about itself: active, and still reaching nobody. */}
        {category.isActive && !category.isVisible ? (
          <span className="mt-1 block text-xs text-amber-700">{t('shadowed')}</span>
        ) : null}
      </td>
      <td className={TD}>
        {category.translatedLocales.length === 0 ? (
          <span className="text-amber-700">{t('noLocales')}</span>
        ) : (
          category.translatedLocales.join(', ')
        )}
      </td>
      <td className={TD}>
        {t('contents', { children: category.childCount, listings: category.listingCount })}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Creating one                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The create panel, which does not exist for a reader.
 *
 * Gated here rather than hidden with CSS: returning `null` keeps the control's words out of the rendered payload
 * entirely, so a colleague who may only read never receives the form at all.
 */
export async function CategoryCreatePanel() {
  const t = await getTranslations('Categories');
  if (!(await canManage())) return null;

  const result = await readCategoryTree({ cookieHeader: await cookieHeader() });
  // Parents to choose from: only a category that can still take a child, which is one below the deepest level.
  const parents =
    result.kind === 'ok'
      ? result.data.categories
          .filter((category) => category.depth < 2)
          .map((category) => ({
            categoryId: category.categoryId,
            label: `${'— '.repeat(category.depth)}${category.name ?? category.slug}`,
          }))
      : [];

  return (
    <section className={CARD}>
      <Heading level={2}>{t('createHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('createNote')}</p>
      <CategoryCreateForm
        parents={parents}
        labels={{
          slug: t('slugLabel'),
          slugHint: t('slugHint'),
          parent: t('parentLabel'),
          noParent: t('noParent'),
          listingType: t('listingTypeLabel'),
          anyListingType: t('anyListingType'),
          product: t('listingTypeProduct'),
          service: t('listingTypeService'),
          sortOrder: t('sortOrderLabel'),
          submit: t('createSubmit'),
          working: t('working'),
          created: t('created'),
          failed: t('failed'),
          slugTaken: t('slugTaken'),
          treeNotAllowed: t('treeNotAllowed'),
          valueNotAllowed: t('valueNotAllowed'),
          nameRequired: t('nameRequired'),
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One category                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export async function CategoryDetailView({ categoryId }: { readonly categoryId: string | undefined }) {
  const t = await getTranslations('Categories');
  const result = await readCategoryDetail(categoryId, { cookieHeader: await cookieHeader() });

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

  // The translations travel on to the panels below as part of the detail, so only the category is unpacked here.
  const { category } = result.data;

  return (
    <>
      <section className={CARD}>
        <Heading level={2}>{category.slug}</Heading>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-ink-muted">{t('publicAddressLabel')}</dt>
          <dd className="text-ink-strong">
            <code>{publicCategoryPath('en', category.slug)}</code>
            <span className="mt-1 block text-xs text-ink-muted">{t('slugImmutable')}</span>
          </dd>
          <dt className="text-ink-muted">{t('columnDepth')}</dt>
          <dd className="text-ink-strong">{category.depth + 1}</dd>
          <dt className="text-ink-muted">{t('parentLabel')}</dt>
          <dd className="text-ink-strong">{category.parentSlug ?? t('noParent')}</dd>
          <dt className="text-ink-muted">{t('listingTypeLabel')}</dt>
          <dd className="text-ink-strong">{category.listingTypeCode ?? t('anyListingType')}</dd>
          <dt className="text-ink-muted">{t('columnOrder')}</dt>
          <dd className="text-ink-strong">{category.sortOrder}</dd>
          <dt className="text-ink-muted">{t('columnState')}</dt>
          <dd className="text-ink-strong">
            {category.isActive ? t('stateShown') : t('stateHidden')}
            {category.isActive && !category.isVisible ? (
              <span className="mt-1 block text-xs text-amber-700">{t('shadowed')}</span>
            ) : null}
          </dd>
          <dt className="text-ink-muted">{t('columnContents')}</dt>
          <dd className="text-ink-strong">
            {t('contents', { children: category.childCount, listings: category.listingCount })}
          </dd>
        </dl>

        {category.canManage ? null : <Message tone="empty" title={t('readOnlyTitle')} body={t('readOnlyBody')} />}
      </section>

      {category.canManage ? <CategoryControls detail={result.data} /> : null}
      <CategoryTranslations detail={result.data} />
    </>
  );
}

/** The forms a manager gets: settings, and the one control a visitor notices. */
async function CategoryControls({ detail }: { readonly detail: AdminCategoryDetailResponse }) {
  const t = await getTranslations('Categories');
  const { category } = detail;
  const tree = await readCategoryTree({ cookieHeader: await cookieHeader() });

  // A category cannot be its own parent or its own descendant, and cannot sit below the deepest level. Offering
  // only what can be accepted is kinder than a refusal, and the database refuses the rest regardless.
  const descendants = tree.kind === 'ok' ? descendantIds(tree.data.categories, category.categoryId) : new Set<string>();
  const parents =
    tree.kind === 'ok'
      ? tree.data.categories
          .filter(
            (option) =>
              option.categoryId !== category.categoryId &&
              !descendants.has(option.categoryId) &&
              option.depth < 2,
          )
          .map((option) => ({
            categoryId: option.categoryId,
            label: `${'— '.repeat(option.depth)}${option.name ?? option.slug}`,
          }))
      : [];

  return (
    <>
      <section className={CARD}>
        <Heading level={2}>{t('settingsHeading')}</Heading>
        <CategorySettingsForm
          categoryId={category.categoryId}
          parentId={category.parentId}
          listingTypeCode={category.listingTypeCode}
          sortOrder={category.sortOrder}
          parents={parents}
          labels={{
            parent: t('parentLabel'),
            noParent: t('noParent'),
            listingType: t('listingTypeLabel'),
            anyListingType: t('anyListingType'),
            product: t('listingTypeProduct'),
            service: t('listingTypeService'),
            sortOrder: t('sortOrderLabel'),
            submit: t('settingsSubmit'),
            working: t('working'),
            saved: t('saved'),
            failed: t('failed'),
            slugTaken: t('slugTaken'),
            treeNotAllowed: t('treeNotAllowed'),
            valueNotAllowed: t('valueNotAllowed'),
            nameRequired: t('nameRequired'),
          }}
        />
      </section>

      <section className={CARD}>
        <Heading level={2}>{t('stateHeading')}</Heading>
        <p className="mt-1 text-sm text-ink-muted">{t('stateNote')}</p>
        <CategoryStateForm
          categoryId={category.categoryId}
          isActive={category.isActive}
          labels={{
            show: t('showSubmit'),
            hide: t('hideSubmit'),
            confirm: t('confirm'),
            working: t('working'),
            saved: t('saved'),
            failed: t('failed'),
            slugTaken: t('slugTaken'),
            treeNotAllowed: t('treeNotAllowed'),
            valueNotAllowed: t('valueNotAllowed'),
            nameRequired: t('nameRequired'),
          }}
        />
      </section>
    </>
  );
}

/** Every category under one, so a move cannot be offered into its own branch. */
function descendantIds(categories: readonly AdminCategoryNode[], rootId: string): Set<string> {
  const found = new Set<string>();
  // The tree arrives in depth order, so one pass downwards reaches every descendant.
  for (const category of categories) {
    if (category.parentId === rootId || (category.parentId !== null && found.has(category.parentId))) {
      found.add(category.categoryId);
    }
  }
  return found;
}

/** The locales, written and unwritten, with the editor for whoever may use it. */
async function CategoryTranslations({ detail }: { readonly detail: AdminCategoryDetailResponse }) {
  const t = await getTranslations('Categories');
  const { category, translations } = detail;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('translationsHeading')}</Heading>
      {translations.length === 0 ? (
        <Message tone="empty" title={t('unwrittenTitle')} body={t('unwrittenBody')} />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnLocale')}</th>
              <th className={TH}>{t('columnName')}</th>
              <th className={TH}>{t('columnMetaTitle')}</th>
              <th className={TH}>{t('columnUpdated')}</th>
            </tr>
          </thead>
          <tbody>
            {translations.map((translation) => (
              <tr key={translation.localeCode}>
                <td className={TD}>{translation.localeCode}</td>
                <td className={TD}>{translation.name}</td>
                <td className={TD}>{translation.metaTitle ?? '—'}</td>
                <td className={TD}>{translation.updatedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {category.canManage ? (
        <CategoryTranslationForm
          categoryId={category.categoryId}
          translations={translations.map((translation) => ({
            localeCode: translation.localeCode,
            name: translation.name,
            description: translation.description,
            metaTitle: translation.metaTitle,
            metaDescription: translation.metaDescription,
          }))}
          labels={{
            locale: t('localeLabel'),
            name: t('nameLabel'),
            description: t('descriptionLabel'),
            metaTitle: t('metaTitleLabel'),
            metaDescription: t('metaDescriptionLabel'),
            clearHint: t('clearHint'),
            submit: t('translationSubmit'),
            remove: t('translationRemove'),
            confirm: t('confirm'),
            working: t('working'),
            saved: t('saved'),
            removed: t('removed'),
            failed: t('failed'),
            slugTaken: t('slugTaken'),
            treeNotAllowed: t('treeNotAllowed'),
            valueNotAllowed: t('valueNotAllowed'),
            nameRequired: t('nameRequired'),
          }}
        />
      ) : null}
    </section>
  );
}
