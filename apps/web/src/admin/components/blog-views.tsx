import { Heading } from '@repo/ui';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import type { BlogPostDetail, BlogPostSummary, BlogTaxonomyResponse } from '@repo/contracts';
import { readBlogPost, readBlogPosts, readBlogTaxonomy, type BlogResult } from '../server/bff';
import {
  BlogCreateForm,
  BlogDetailsForm,
  BlogFilterForm,
  BlogStatusForm,
  BlogTagsForm,
  BlogTaxonomyForm,
  BlogTranslationForm,
} from './blog-forms';
import { adminPath } from '../paths';

/**
 * The blog section (0092).
 *
 * **Every panel renders inside the page's `RequireStaff` gate**, so a colleague who may not open this section
 * receives a refusal and no data — not hidden data, no data.
 *
 * **The controls are rendered from the server's answer, not from a role.** `canManage` comes back on the post detail
 * and on the taxonomy, because reading and managing are separate seeded keys.
 *
 * **It says what this section does not do.** There is no sitemap entry for the blog, no metadata override for a post,
 * no comments, no reactions and no byline picker — each of which an operator could reasonably expect, and each of
 * which would otherwise be a silent disappointment. The post's own meta fields are where its `<head>` comes from, and
 * the translation panel says so where somebody is editing them.
 */

const CARD = 'mt-6 rounded-lg border border-hairline bg-surface-raised p-5';
const TABLE = 'mt-4 w-full border-collapse text-left text-sm';
const TH = 'border-b border-hairline pb-2 pr-4 font-medium text-ink-muted';
const TD = 'border-b border-hairline py-2 pr-4 align-top text-ink-strong';

/** The locales the public site serves. Which codes exist is the database's; this offers the two it seeds. */
const LOCALES = ['en', 'ar'] as const;

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not data. */
async function problem<T>(result: BlogResult<T>): Promise<string | null> {
  const t = await getTranslations('Blog');
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
        tone === 'error' ? 'border-red-200 bg-red-50' : 'border-hairline bg-surface-sunken'
      }`}
    >
      <p className="font-medium text-ink-strong">{title}</p>
      <p className="mt-1 text-sm text-ink-body">{body}</p>
    </div>
  );
}

/** The query a page link must keep, so paging does not silently drop a filter. */
function carried(status: string | null, search: string | null): string {
  const params = new URLSearchParams();
  if (status !== null && status !== '') params.set('status', status);
  if (search !== null && search !== '') params.set('search', search);
  return params.toString();
}

/* ------------------------------------------------------------------------------------------------ */
/* The list                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface BlogListProps {
  readonly cursor: string | null;
  readonly status: string | null;
  readonly search: string | null;
}

export async function BlogList({ cursor, status, search }: BlogListProps) {
  const t = await getTranslations('Blog');
  const result = await readBlogPosts({ cursor, status, search }, { cookieHeader: await cookieHeader() });
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
  const keep = carried(status, search);
  const filtered = status !== null || search !== null;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('listHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('listIntro')}</p>
      {/* Said out loud, because an operator cannot deduce any of it from anything on the screen. */}
      <Message tone="empty" title={t('notHereTitle')} body={t('notHereBody')} />

      <BlogFilterForm
        initial={{ status, search }}
        copy={{
          statusLabel: t('statusLabel'),
          statusAny: t('statusAny'),
          searchLabel: t('searchLabel'),
          searchHint: t('searchHint'),
          submit: t('filterSubmit'),
          clear: t('filterClear'),
        }}
      />

      {items.length === 0 ? (
        <Message
          tone="empty"
          title={filtered ? t('noMatchesTitle') : t('emptyTitle')}
          body={filtered ? t('noMatchesBody') : t('emptyBody')}
        />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnSlug')}</th>
              <th className={TH}>{t('columnTitle')}</th>
              <th className={TH}>{t('columnStatus')}</th>
              <th className={TH}>{t('columnCategory')}</th>
              <th className={TH}>{t('columnLocales')}</th>
              <th className={TH}>{t('columnUpdated')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((post) => (
              <BlogRow key={post.id} post={post} untitled={t('untitled')} none={t('noCategory')} />
            ))}
          </tbody>
        </table>
      )}

      {nextCursor === null ? null : (
        <p className="mt-4">
          <Link
            className="text-sm text-ink-strong underline"
            href={`/blog?cursor=${encodeURIComponent(nextCursor)}${keep === '' ? '' : `&${keep}`}`}
          >
            {t('nextPage')}
          </Link>
        </p>
      )}
    </section>
  );
}

function BlogRow({
  post,
  untitled,
  none,
}: {
  readonly post: BlogPostSummary;
  readonly untitled: string;
  readonly none: string;
}) {
  return (
    <tr>
      <td className={TD}>
        <Link className="text-ink-strong underline" href={adminPath(`/blog/${post.id}`)}>
          <code>{post.slug}</code>
        </Link>
      </td>
      <td className={TD}>{post.title ?? untitled}</td>
      <td className={TD}>
        {post.status}
        {post.isFeatured ? ' ★' : ''}
      </td>
      <td className={TD}>{post.categorySlug ?? none}</td>
      <td className={TD}>
        {/* Empty is a real state: a post nobody has written, which is also the one that cannot be published. */}
        <code>{post.translatedLocales.length === 0 ? '—' : post.translatedLocales.join(', ')}</code>
      </td>
      <td className={TD}>
        <time dateTime={post.updatedAt}>{post.updatedAt.slice(0, 10)}</time>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Adding                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Adding a post needs `cms.blog.manage`, which is a different key from the one that opens this section.
 *
 * The list response carries no capability flag — only the detail and the taxonomy do — so this panel asks the
 * taxonomy, which it needs for its category options anyway. A colleague holding only the read key gets **no panel at
 * all**, not a disabled one.
 */
export async function BlogAddPanel() {
  const t = await getTranslations('Blog');
  const taxonomy = await readBlogTaxonomy({ cookieHeader: await cookieHeader() });
  if (taxonomy.kind !== 'ok' || !taxonomy.data.canManage) return null;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('addHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('addIntro')}</p>
      <BlogCreateForm
        categories={taxonomy.data.categories
          .filter((category) => category.isActive)
          .map((category) => ({ id: category.id, name: category.nameEn }))}
        copy={{
          slugLabel: t('slugLabel'),
          slugHint: t('slugHint'),
          categoryLabel: t('categoryLabel'),
          categoryNone: t('categoryNone'),
          indexableLabel: t('indexableLabel'),
          submit: t('createSubmit'),
          draftNotice: t('draftNotice'),
          failed: t('saveFailed'),
          invalid: t('invalid'),
          slugTaken: t('slugTaken'),
          referenceUnknown: t('referenceUnknown'),
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One post                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export async function BlogDetailView({ postId }: { readonly postId: string | undefined }) {
  const t = await getTranslations('Blog');
  const cookie = await cookieHeader();
  const result = await readBlogPost(postId, { cookieHeader: cookie });

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

  const post = result.data;
  // Only read when it will be used. A reader sees no controls, so there is nothing to populate.
  const taxonomy = post.canManage ? await readBlogTaxonomy({ cookieHeader: cookie }) : null;

  return (
    <>
      <BlogSummaryPanel post={post} />
      {!post.canManage ? (
        <section className={CARD}>
          <Heading level={2}>{t('readOnlyHeading')}</Heading>
          <Message tone="empty" title={t('readOnlyTitle')} body={t('readOnlyBody')} />
        </section>
      ) : (
        <>
          <BlogDetailsPanel post={post} taxonomy={taxonomy} />
          <BlogStatusPanel post={post} />
          <BlogTranslationsPanel post={post} />
          <BlogTagsPanel post={post} taxonomy={taxonomy} />
        </>
      )}
    </>
  );
}

async function BlogSummaryPanel({ post }: { readonly post: BlogPostDetail }) {
  const t = await getTranslations('Blog');
  return (
    <section className={CARD}>
      <Heading level={2}>{t('detailHeading')}</Heading>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Row label={t('fieldSlug')} value={<code>{post.slug}</code>} />
        <Row label={t('fieldStatus')} value={post.status} />
        <Row label={t('fieldFeatured')} value={post.isFeatured ? t('yes') : t('no')} />
        <Row label={t('fieldIndexable')} value={post.isIndexable ? t('yes') : t('no')} />
        <Row label={t('fieldCategory')} value={post.categorySlug ?? t('noCategory')} />
        <Row
          label={t('fieldPublished')}
          value={post.publishedAt === null ? t('never') : post.publishedAt.slice(0, 10)}
        />
        <Row
          label={t('fieldScheduled')}
          value={post.scheduledFor === null ? t('never') : post.scheduledFor.slice(0, 16).replace('T', ' ')}
        />
        <Row
          label={t('fieldCover')}
          value={post.coverObjectPath === null ? t('noCover') : <code>{post.coverObjectPath}</code>}
        />
        {post.coverMediaId === null ? null : (
          <>
            {/* 0099: the alt text somebody wrote, so an operator can tell which entry is attached. */}
            <Row label={t('fieldCoverAltEn')} value={post.coverAltTextEn ?? t('noCoverAlt')} />
            <Row label={t('fieldCoverAltAr')} value={post.coverAltTextAr ?? t('noCoverAlt')} />
          </>
        )}
      </dl>
      {/* A cover is a storage path, and there is no media origin to turn one into a URL. Said rather than implied. */}
      <Message tone="empty" title={t('coverTitle')} body={t('coverBody')} />
      {post.previousSlugs.length === 0 ? null : (
        <div className="mt-4">
          <p className="text-sm font-medium text-ink-body">{t('previousSlugsHeading')}</p>
          <p className="mt-1 text-sm text-ink-muted">{t('previousSlugsBody')}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {post.previousSlugs.map((slug) => (
              <li key={slug}>
                <code>{slug}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div>
      <dt className="font-medium text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-ink-strong">{value}</dd>
    </div>
  );
}

async function BlogDetailsPanel({
  post,
  taxonomy,
}: {
  readonly post: BlogPostDetail;
  readonly taxonomy: BlogResult<BlogTaxonomyResponse> | null;
}) {
  const t = await getTranslations('Blog');
  const categories =
    taxonomy?.kind === 'ok'
      ? taxonomy.data.categories
          .filter((category) => category.isActive || category.id === post.categoryId)
          .map((category) => ({ id: category.id, name: category.nameEn }))
      : [];

  return (
    <section className={CARD}>
      <Heading level={2}>{t('editHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('editIntro')}</p>
      <BlogDetailsForm
        postId={post.id}
        initial={{
          slug: post.slug,
          categoryId: post.categoryId,
          coverMediaId: post.coverMediaId,
          isIndexable: post.isIndexable,
          isFeatured: post.isFeatured,
        }}
        categories={categories}
        copy={{
          slugLabel: t('slugLabel'),
          slugHint: t('renameHint'),
          categoryLabel: t('categoryLabel'),
          categoryNone: t('categoryNone'),
          indexableLabel: t('indexableLabel'),
          featuredLabel: t('featuredLabel'),
          featuredHint: t('featuredHint'),
          coverLabel: t('coverMediaIdLabel'),
          coverHint: t('coverMediaIdHint'),
          submit: t('saveSubmit'),
          failed: t('saveFailed'),
          invalid: t('invalid'),
          notAllowed: t('notAllowed'),
          slugTaken: t('slugTaken'),
          referenceUnknown: t('referenceUnknown'),
        }}
      />
    </section>
  );
}

async function BlogStatusPanel({ post }: { readonly post: BlogPostDetail }) {
  const t = await getTranslations('Blog');
  return (
    <section className={CARD}>
      <Heading level={2}>{t('statusHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('statusIntro')}</p>
      {post.translations.length === 0 ? (
        <Message tone="empty" title={t('unwrittenTitle')} body={t('unwrittenBody')} />
      ) : null}
      <BlogStatusForm
        postId={post.id}
        current={post.status}
        copy={{
          statusLabel: t('statusLabel'),
          scheduledLabel: t('scheduledLabel'),
          scheduledHint: t('scheduledHint'),
          submit: t('statusSubmit'),
          failed: t('saveFailed'),
          invalid: t('invalid'),
          localeRequired: t('localeRequired'),
          notAllowed: t('notAllowed'),
        }}
      />
    </section>
  );
}

async function BlogTranslationsPanel({ post }: { readonly post: BlogPostDetail }) {
  const t = await getTranslations('Blog');
  const copy = {
    titleLabel: t('titleLabel'),
    excerptLabel: t('excerptLabel'),
    bodyLabel: t('bodyLabel'),
    metaTitleLabel: t('metaTitleLabel'),
    metaTitleHint: t('metaTitleHint'),
    metaDescriptionLabel: t('metaDescriptionLabel'),
    replaceNotice: t('replaceNotice'),
    submit: t('saveSubmit'),
    remove: t('removeLocale'),
    removeConfirm: t('removeLocaleConfirm'),
    failed: t('saveFailed'),
    invalid: t('invalid'),
    localeRequired: t('localeRequired'),
    notAllowed: t('notAllowed'),
  };

  return (
    <section className={CARD}>
      <Heading level={2}>{t('translationsHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('translationsIntro')}</p>
      {LOCALES.map((locale) => {
        const existing = post.translations.find((entry) => entry.localeCode === locale);
        return (
          <div className="mt-6 border-t border-hairline pt-4" key={locale}>
            <Heading level={3}>{locale === 'ar' ? t('localeArabic') : t('localeEnglish')}</Heading>
            <BlogTranslationForm
              postId={post.id}
              localeCode={locale}
              initial={{
                title: existing?.title ?? '',
                excerpt: existing?.excerpt ?? '',
                body: existing?.body ?? '',
                metaTitle: existing?.metaTitle ?? '',
                metaDescription: existing?.metaDescription ?? '',
                exists: existing !== undefined,
              }}
              copy={copy}
            />
          </div>
        );
      })}
    </section>
  );
}

async function BlogTagsPanel({
  post,
  taxonomy,
}: {
  readonly post: BlogPostDetail;
  readonly taxonomy: BlogResult<BlogTaxonomyResponse> | null;
}) {
  const t = await getTranslations('Blog');
  const tags =
    taxonomy?.kind === 'ok'
      ? taxonomy.data.tags
          .filter((tag) => tag.isActive || post.tagIds.includes(tag.id))
          .map((tag) => ({ id: tag.id, name: tag.nameEn, isActive: tag.isActive }))
      : [];

  return (
    <section className={CARD}>
      <Heading level={2}>{t('tagsHeading')}</Heading>
      <BlogTagsForm
        postId={post.id}
        tags={tags}
        selected={post.tagIds}
        copy={{
          heading: t('tagsHeading'),
          notice: t('tagsNotice'),
          submit: t('saveSubmit'),
          empty: t('tagsEmpty'),
          failed: t('saveFailed'),
          invalid: t('invalid'),
          referenceUnknown: t('referenceUnknown'),
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The taxonomy                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export async function BlogTaxonomyView() {
  const t = await getTranslations('Blog');
  const result = await readBlogTaxonomy({ cookieHeader: await cookieHeader() });

  if (result.kind !== 'ok') {
    const failure = await problem(result);
    return (
      <section className={CARD}>
        <Heading level={2}>{t('taxonomyHeading')}</Heading>
        <Message
          tone={result.kind === 'notFound' ? 'empty' : 'error'}
          title={result.kind === 'notFound' ? t('notFoundTitle') : t('unavailableTitle')}
          body={failure ?? t('unavailable')}
        />
      </section>
    );
  }

  const { categories, tags, canManage } = result.data;
  const copy = {
    slugLabel: t('slugLabel'),
    nameEnLabel: t('nameEnLabel'),
    nameArLabel: t('nameArLabel'),
    nameArHint: t('nameArHint'),
    sortOrderLabel: t('sortOrderLabel'),
    activeLabel: t('activeLabel'),
    submit: t('saveSubmit'),
    failed: t('saveFailed'),
    invalid: t('invalid'),
    slugTaken: t('slugTaken'),
    notAllowed: t('notAllowed'),
  };

  return (
    <section className={CARD}>
      <Heading level={2}>{t('taxonomyHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('taxonomyIntro')}</p>
      {/* The count is of every post, not the public ones. Said, because the two numbers differ and both are real. */}
      <Message tone="empty" title={t('countsTitle')} body={t('countsBody')} />

      <Heading level={3}>{t('categoriesHeading')}</Heading>
      {categories.length === 0 ? (
        <p className="mt-2 text-sm text-ink-muted">{t('categoriesEmpty')}</p>
      ) : (
        <ul className="mt-2 space-y-4">
          {categories.map((category) => (
            <li className="border-t border-hairline pt-3" key={category.id}>
              <p className="text-sm text-ink-strong">
                <code>{category.slug}</code> — {category.nameEn}
                {category.isActive ? '' : ` (${t('inactive')})`} · {t('postCount', { count: category.postCount })}
              </p>
              {!canManage ? null : (
                <BlogTaxonomyForm
                  kind="category"
                  entryId={category.id}
                  initial={{
                    slug: category.slug,
                    nameEn: category.nameEn,
                    nameAr: category.nameAr ?? '',
                    sortOrder: category.sortOrder,
                    isActive: category.isActive,
                  }}
                  copy={copy}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {!canManage ? null : (
        <div className="mt-6 border-t border-hairline pt-4">
          <Heading level={3}>{t('addCategoryHeading')}</Heading>
          <BlogTaxonomyForm
            kind="category"
            entryId={null}
            initial={{ slug: '', nameEn: '', nameAr: '', sortOrder: 0, isActive: true }}
            copy={copy}
          />
        </div>
      )}

      <div className="mt-8 border-t border-hairline pt-4">
        <Heading level={3}>{t('tagsTaxonomyHeading')}</Heading>
        {tags.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">{t('tagsTaxonomyEmpty')}</p>
        ) : (
          <ul className="mt-2 space-y-4">
            {tags.map((tag) => (
              <li className="border-t border-hairline pt-3" key={tag.id}>
                <p className="text-sm text-ink-strong">
                  <code>{tag.slug}</code> — {tag.nameEn}
                  {tag.isActive ? '' : ` (${t('inactive')})`} · {t('postCount', { count: tag.postCount })}
                </p>
                {!canManage ? null : (
                  <BlogTaxonomyForm
                    kind="tag"
                    entryId={tag.id}
                    initial={{
                      slug: tag.slug,
                      nameEn: tag.nameEn,
                      nameAr: tag.nameAr ?? '',
                      sortOrder: 0,
                      isActive: tag.isActive,
                    }}
                    copy={copy}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {!canManage ? null : (
          <div className="mt-6 border-t border-hairline pt-4">
            <Heading level={3}>{t('addTagHeading')}</Heading>
            <BlogTaxonomyForm
              kind="tag"
              entryId={null}
              initial={{ slug: '', nameEn: '', nameAr: '', sortOrder: 0, isActive: true }}
              copy={copy}
            />
          </div>
        )}
      </div>
    </section>
  );
}
