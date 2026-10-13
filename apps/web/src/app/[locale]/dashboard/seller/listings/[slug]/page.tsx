import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ListingMessage } from '../../../../../../components/listing-views';
import {
  ListingPhotoManager,
  type ListingPhotoCopy,
} from '../../../../../../components/listing-photo-manager';
import { RequireSession } from '../../../../../../components/require-session';
import {
  SellerVocabularyForm,
  type RenderableAttribute,
  type RenderableTag,
  type SellerVocabularyEditLabels,
  type SellerVocabularyLabels,
} from '../../../../../../components/seller-vocabulary-form';
import { readListingMedia, readSellerListingVocabulary } from '../../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerVocabulary');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * `/dashboard/seller/listings/:slug` — the structured details and tags of one of the caller's own listings
 * (Phase 8-C).
 *
 * **Why this is a route and the rest of the edit is not.** 6-F put editing inline because the listings read
 * already carried every editable field, so a second read would have been waste. It does not carry these: the
 * questions a listing is asked depend on its category, and the answers and tags are their own reads. Putting them
 * on the index would mean two upstream calls per row for a page nobody had asked to edit, so they live here, one
 * listing at a time, read once when somebody opens it.
 *
 * **Protection is 5-A's, unchanged.** Everything is inside {@link RequireSession}, a server component rather than
 * a layout, for the reason 6-B established: a layout that declines to render `children` still streams the page
 * segment's RSC payload.
 *
 * **Everything is read on the server and projected field by field.** No identifier of an attribute, an option, a
 * definition or a listing reaches the browser — a client component's props are part of the RSC payload, so the
 * projection is what decides what a browser gets. Options travel as values, which is what the save sends back.
 *
 * **A slug that is not the caller's reads exactly as one that does not exist**, because the API answers both the
 * same way and this page does not try to tell them apart.
 *
 * **0116 adds the photographs to this screen**, for the reason the vocabulary is here rather than on the index:
 * a listing's pictures are their own read and nobody wants twenty of them fetched for a page they came to
 * browse. The two reads happen together, and the photographs section is independent of the vocabulary one — a
 * category that asks no questions is still a listing somebody wants to put pictures on.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale; readonly slug: string }>;
}) {
  const [{ locale, slug }, t, sellers, photos] = await Promise.all([
    params,
    getTranslations('SellerVocabulary'),
    getTranslations('Sellers'),
    getTranslations('ListingPhotos'),
  ]);
  const prefix = locale === 'ar' ? '/ar' : '';
  const cookieHeader = (await headers()).get('cookie');
  // Both reads together: they are independent, and one round trip of latency is better than two.
  const [vocabulary, media] = await Promise.all([
    readSellerListingVocabulary('listings', slug, locale === 'ar' ? 'ar' : 'en', { cookieHeader }),
    readListingMedia(slug, { cookieHeader }),
  ]);

  const photoCopy: ListingPhotoCopy = {
    heading: photos('heading'),
    intro: photos('intro'),
    add: photos('add'),
    working: photos('working'),
    none: photos('none'),
    primary: photos('primary'),
    makePrimary: photos('makePrimary'),
    remove: photos('remove'),
    unpublished: photos('unpublished'),
    wrongType: photos('wrongType'),
    tooLarge: photos('tooLarge'),
    tooSmall: photos('tooSmall'),
    failed: photos('failed'),
    unsupported: photos('unsupported'),
    photoNumber: ({ number, total }) => photos('photoNumber', { number, total }),
  };

  const labels: SellerVocabularyLabels = {
    attributesHeading: t('attributesHeading'),
    attributesIntro: t('attributesIntro'),
    required: t('required'),
    advisory: t('advisory'),
    noAnswer: t('noAnswer'),
    yes: t('yes'),
    no: t('no'),
    listSeparator: t('listSeparator'),
    tagsHeading: t('tagsHeading'),
    tagsIntro: t('tagsIntro'),
    noQuestions: t('noQuestions'),
    noTags: t('noTags'),
    notEditable: t('notEditable'),
  };

  // Withheld entirely when the listing is no longer a draft, so a control that is not permitted has no text to
  // render with and its copy never reaches a browser.
  const editing: SellerVocabularyEditLabels | null =
    vocabulary.kind === 'ok' && vocabulary.isEditable
      ? {
          save: t('save'),
          saving: t('saving'),
          saved: t('saved'),
          saveTags: t('saveTags'),
          tagsSaved: t('tagsSaved'),
          errorRefused: t('errorRefused'),
          errorNotEditable: t('errorNotEditable'),
          errorInvalid: t('errorInvalid'),
          errorUnavailable: t('errorUnavailable'),
        }
      : null;

  // Projected field by field, so nothing the form does not need can reach a browser.
  const attributes: RenderableAttribute[] =
    vocabulary.kind === 'ok'
      ? vocabulary.attributes.map((attribute) => ({
          key: attribute.key,
          label: attribute.label,
          dataType: attribute.dataType,
          unit: attribute.unit,
          isRequired: attribute.isRequired,
          text: attribute.text,
          number: attribute.number,
          boolean: attribute.boolean,
          options: [...attribute.options],
          choices: attribute.choices.map((choice) => ({ value: choice.value, label: choice.label })),
        }))
      : [];
  const tags: RenderableTag[] =
    vocabulary.kind === 'ok'
      ? vocabulary.tags.map((tag) => ({ slug: tag.slug, name: tag.name, isSelected: tag.isSelected }))
      : [];

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2">
            <Link
              href={`${prefix}/dashboard/seller/listings`}
              className="text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
            >
              {t('backToListings')}
            </Link>
          </p>

          {vocabulary.kind === 'not_found' ? (
            <div className="mt-8">
              <ListingMessage tone="empty" title={t('errorNotFound')} description={t('backToListings')} />
            </div>
          ) : vocabulary.kind === 'unavailable' ? (
            // Deliberately not folded into an empty state: a failing service must never read as "this asks
            // for nothing", which would be a page telling somebody their answers had vanished.
            <div className="mt-8">
              <ListingMessage tone="error" title={t('errorUnavailable')} description={sellers('error')} />
            </div>
          ) : vocabulary.kind === 'ok' ? (
            <>
              {/*
                The photographs first: they are what a seller came to add, and a column of structured questions
                above them would bury the one control they were looking for. Rendered only when the read
                succeeded — a failed photographs read is not allowed to take the vocabulary form down with it,
                and an empty section would claim the listing has no pictures when the truth is we could not ask.
              */}
              {media.kind === 'ok' ? (
                <div className="mt-8">
                  <ListingPhotoManager slug={slug} initial={media.items} copy={photoCopy} />
                </div>
              ) : null}
              <SellerVocabularyForm
                path={`/api/sellers/me/listings/${encodeURIComponent(slug)}`}
                attributes={attributes}
                tags={tags}
                labels={labels}
                editing={editing}
              />
            </>
          ) : null}
        </div>
      </PageContainer>
    </RequireSession>
  );
}
