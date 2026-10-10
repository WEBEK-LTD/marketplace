import { Heading } from '@repo/ui';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { isCmsPageSlug } from '@repo/config';
import type { FaqSummary, FaqTopicSummary } from '@repo/contracts';
import { readFaq, readFaqTopics, readFaqs, type FaqResult } from '../server/bff';
import { FaqBackLink, FaqControls, FaqCreateForm, FaqReorderForm } from './faqs-forms';
import { adminPath } from '../paths';

/**
 * The help-centre section (0095).
 *
 * **Every panel renders inside the page's `RequireStaff` gate**, so a colleague who may not open this section
 * receives a refusal and no data.
 *
 * **The controls are rendered from the server's answer, not from a role.** `canManage` comes back on the list and
 * on the detail, because reading and authoring are separate seeded keys.
 *
 * **Two things an operator could not otherwise work out are said out loud.** A topic no public page shows is named
 * and explained — the database answers that from `pages.page_key`, which is owner decision 1's mapping. And a topic
 * mapped to a page at an address this application does not serve is marked here, because the route map lives in
 * `@repo/config` and only this layer can check it.
 */

const CARD = 'mt-6 rounded-lg border border-hairline bg-surface-raised p-5';
const TABLE = 'mt-4 w-full border-collapse text-left text-sm';
const TH = 'border-b border-hairline pb-2 pr-4 font-medium text-ink-muted';
const TD = 'border-b border-hairline py-2 pr-4 align-top text-ink-strong';

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not data. */
async function problem<T>(result: FaqResult<T>): Promise<string | null> {
  const t = await getTranslations('Faqs');
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
 * Whether the page that shows a topic sits at an address this application actually serves.
 *
 * The database answers the mapping; the closed set of served page addresses is the *web application's* route map,
 * which is why this check is here. A topic mapped to a published page the public site serves no address for shows
 * its questions to nobody, and nothing else on any screen would ever say so.
 */
function isUnservable(entry: { readonly isMapped: boolean; readonly pageSlug: string | null }): boolean {
  return entry.isMapped && entry.pageSlug !== null && !isCmsPageSlug(entry.pageSlug);
}

/* ------------------------------------------------------------------------------------------------ */
/* The topics                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export async function FaqTopicsPanel() {
  const t = await getTranslations('Faqs');
  const result = await readFaqTopics({ cookieHeader: await cookieHeader() });
  const failure = await problem(result);

  if (failure !== null || result.kind !== 'ok') {
    return (
      <section className={CARD}>
        <Heading level={2}>{t('topicsHeading')}</Heading>
        <Message tone="error" title={t('unavailableTitle')} body={failure ?? t('unavailable')} />
      </section>
    );
  }

  const { topics } = result.data;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('topicsHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('topicsIntro')}</p>
      {/* Said out loud, because an operator cannot deduce any of it from anything on the screen. */}
      <Message tone="empty" title={t('notHereTitle')} body={t('notHereBody')} />

      {topics.length === 0 ? (
        <Message tone="empty" title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnTopic')}</th>
              <th className={TH}>{t('columnEntries')}</th>
              <th className={TH}>{t('columnShownOn')}</th>
              <th className={TH}>{t('columnNotes')}</th>
            </tr>
          </thead>
          <tbody>
            {topics.map((topic) => (
              <tr key={topic.topic}>
                <td className={TD}>
                  <Link
                    className="text-ink-strong underline"
                    href={adminPath(`/cms/faqs?topic=${encodeURIComponent(topic.topic)}`)}
                  >
                    <code>{topic.topic}</code>
                  </Link>
                </td>
                <td className={TD}>
                  {t('entriesCount', { total: topic.entryCount, published: topic.publishedCount })}
                </td>
                <td className={TD}>
                  {topic.pageSlug === null ? '—' : <code>/{topic.pageSlug}</code>}
                </td>
                <td className={TD}>
                  {!topic.isMapped ? <p className="text-amber-700">{t('notShown')}</p> : null}
                  {isUnservable(topic) ? <p className="text-amber-700">{t('unservablePage')}</p> : null}
                  {topic.isMapped && topic.publishedCount === 0 ? (
                    <p className="text-ink-muted">{t('nothingPublished')}</p>
                  ) : null}
                  {topic.isMapped && !isUnservable(topic) && topic.publishedCount > 0 ? '—' : null}
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
/* The entries                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export async function FaqList({ topic }: { readonly topic?: string | undefined }) {
  const t = await getTranslations('Faqs');
  const cookie = await cookieHeader();
  const result = await readFaqs({ topic: topic ?? null }, { cookieHeader: cookie });
  const failure = await problem(result);

  if (failure !== null || result.kind !== 'ok') {
    return (
      <section className={CARD}>
        <Heading level={2}>{t('listHeading')}</Heading>
        <Message tone="error" title={t('unavailableTitle')} body={failure ?? t('unavailable')} />
      </section>
    );
  }

  const { items, canManage } = result.data;
  // One topic's worth of entries is the only thing an order can be applied to, so the control appears only when
  // the list is narrowed to one — decided here rather than inside the form, because a client component's whole
  // props object is serialised into the RSC payload and a control that returns null still leaks its words.
  const sameTopic = topic !== undefined && items.length > 1 && items.every((entry) => entry.topic === topic);

  return (
    <section className={CARD}>
      <Heading level={2}>{t('listHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('listIntro')}</p>
      {topic === undefined ? null : (
        <p className="mt-2 text-sm">
          <Link className="text-ink-strong underline" href={adminPath('/cms/faqs')}>
            {t('showAllTopics')}
          </Link>
        </p>
      )}

      {items.length === 0 ? (
        <Message tone="empty" title={t('noEntriesTitle')} body={t('noEntriesBody')} />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnQuestion')}</th>
              <th className={TH}>{t('columnTopic')}</th>
              <th className={TH}>{t('columnPublished')}</th>
              <th className={TH}>{t('columnNotes')}</th>
              <th className={TH}>{t('columnUpdated')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td className={TD}>
                  <Link className="text-ink-strong underline" href={adminPath(`/cms/faqs/${entry.id}`)}>
                    {entry.questionEn}
                  </Link>
                </td>
                <td className={TD}>
                  <code>{entry.topic}</code>
                </td>
                <td className={TD}>{entry.isPublished ? t('published') : t('unpublished')}</td>
                <td className={TD}>
                  {!entry.isMapped ? <p className="text-amber-700">{t('notShown')}</p> : null}
                  {isUnservable(entry) ? <p className="text-amber-700">{t('unservablePage')}</p> : null}
                  {entry.questionAr === null ? <p className="text-ink-muted">{t('noArabic')}</p> : null}
                  {entry.isMapped && !isUnservable(entry) && entry.questionAr !== null ? '—' : null}
                </td>
                <td className={TD}>
                  <time dateTime={entry.updatedAt}>{entry.updatedAt.slice(0, 10)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {result.data.nextCursor === null ? null : (
        <p className="mt-4 text-sm">
          <Link
            className="text-ink-strong underline"
            href={adminPath(`/cms/faqs?${new URLSearchParams({
              ...(topic === undefined ? {} : { topic }),
              cursor: result.data.nextCursor,
            }).toString()}`)}
          >
            {t('nextPage')}
          </Link>
        </p>
      )}

      {!canManage || !sameTopic ? null : (
        <FaqReorderForm
          copy={{
            heading: t('reorderHeading'),
            hint: t('reorderHint'),
            up: t('moveUp'),
            down: t('moveDown'),
            submit: t('reorderSubmit'),
            failed: t('saveFailed'),
            invalid: t('invalid'),
          }}
          entries={items.map((entry) => ({ id: entry.id, label: entry.questionEn }))}
          topic={topic}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Adding                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Adding an entry needs `cms.faq.manage`, a different key from the one that opens this section.
 *
 * The capability comes from the list response, which this panel reads anyway. A colleague holding only the read key
 * gets **no panel at all**, not a disabled one.
 */
export async function FaqAddPanel() {
  const t = await getTranslations('Faqs');
  const cookie = await cookieHeader();
  const [list, topics] = await Promise.all([
    readFaqs({}, { cookieHeader: cookie }),
    readFaqTopics({ cookieHeader: cookie }),
  ]);
  if (list.kind !== 'ok' || !list.data.canManage) return null;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('addHeading')}</Heading>
      <p className="mt-1 text-sm text-ink-muted">{t('addIntro')}</p>
      <FaqCreateForm
        copy={{ ...(await entryCopy()), unpublishedNotice: t('unpublishedNotice') }}
        topics={topics.kind === 'ok' ? topicNames(topics.data.topics) : []}
      />
    </section>
  );
}

/** The topics already in use, as suggestions. Typing a new one is the point of a free-form topic. */
function topicNames(topics: readonly FaqTopicSummary[]): readonly string[] {
  return topics.map((topic) => topic.topic);
}

/** The labels every entry form needs, in one place because two screens use them. */
async function entryCopy() {
  const t = await getTranslations('Faqs');
  return {
    topicLabel: t('topicLabel'),
    topicHint: t('topicHint'),
    questionEnLabel: t('questionEnLabel'),
    questionArLabel: t('questionArLabel'),
    answerEnLabel: t('answerEnLabel'),
    answerArLabel: t('answerArLabel'),
    answerHint: t('answerHint'),
    sortOrderLabel: t('sortOrderLabel'),
    submit: t('saveSubmit'),
    failed: t('saveFailed'),
    invalid: t('invalid'),
    notAllowed: t('notAllowed'),
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* One entry                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export async function FaqDetailView({ faqId }: { readonly faqId: string | undefined }) {
  const t = await getTranslations('Faqs');
  const cookie = await cookieHeader();
  const result = await readFaq(faqId, { cookieHeader: cookie });
  const failure = await problem(result);

  if (failure !== null || result.kind !== 'ok') {
    return (
      <section className={CARD}>
        <Heading level={2}>{t('detailHeading')}</Heading>
        <p className="mt-2 text-sm">
          <FaqBackLink label={t('backToList')} />
        </p>
        <Message
          tone="error"
          title={result.kind === 'notFound' ? t('notFoundTitle') : t('unavailableTitle')}
          body={failure ?? t('unavailable')}
        />
      </section>
    );
  }

  const faq = result.data;
  const topics = await readFaqTopics({ cookieHeader: cookie });

  return (
    <section className={CARD}>
      <Heading level={2}>{t('detailHeading')}</Heading>
      <p className="mt-2 text-sm">
        <FaqBackLink label={t('backToList')} />
      </p>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Row label={t('columnTopic')} value={<code>{faq.topic}</code>} />
        <Row label={t('columnPublished')} value={faq.isPublished ? t('published') : t('unpublished')} />
        <Row
          label={t('columnShownOn')}
          value={faq.pageSlug === null ? t('notShown') : <code>/{faq.pageSlug}</code>}
        />
        <Row label={t('columnUpdated')} value={<time dateTime={faq.updatedAt}>{faq.updatedAt}</time>} />
      </dl>

      {/* The answer as the public would read it: paragraphs split on blank lines and nothing interpreted as
          markup, which is owner decision 3 shown rather than described. */}
      <div className="mt-4">
        <p className="text-sm font-medium text-ink-body">{t('previewHeading')}</p>
        <p className="mt-1 text-xs text-ink-muted">{t('previewHint')}</p>
        <div className="mt-2 rounded-md border border-hairline bg-surface-sunken p-4">
          <p className="font-medium text-ink-strong">{faq.questionEn}</p>
          {paragraphsOf(faq.answerEn).map((paragraph, index) => (
            <p className="mt-2 text-sm text-ink-body" key={index}>
              {paragraph}
            </p>
          ))}
        </div>
      </div>

      {!faq.isMapped ? <Message tone="empty" title={t('notShown')} body={t('notShownBody')} /> : null}
      {isUnservable(faq) ? (
        <Message tone="error" title={t('unservablePage')} body={t('unservablePageBody')} />
      ) : null}

      {faq.canManage ? (
        <FaqControls
          answerAr={faq.answerAr}
          answerEn={faq.answerEn}
          copy={{
            ...(await entryCopy()),
            clearArabic: t('clearArabic'),
            toggle: faq.isPublished ? t('unpublish') : t('publish'),
            remove: t('remove'),
            removeConfirm: t('removeConfirm'),
          }}
          faqId={faq.id}
          isPublished={faq.isPublished}
          questionAr={faq.questionAr}
          questionEn={faq.questionEn}
          sortOrder={faq.sortOrder}
          topic={faq.topic}
          topics={topics.kind === 'ok' ? topicNames(topics.data.topics) : []}
        />
      ) : null}
    </section>
  );
}

/** Splits on blank lines. An answer with no blank line is one paragraph, which is the common case. */
function paragraphsOf(answer: string): readonly string[] {
  return answer
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

function Row({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-ink-strong">{value}</dd>
    </div>
  );
}

/** Exported for the list screen, which needs the same shape. */
export type { FaqSummary };
