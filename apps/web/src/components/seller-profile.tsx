import type { PublicSellerProfile, SellerAvailability } from '@repo/contracts';
import { Alert, Avatar, Card, EmptyLine, Heading, TYPE, cx } from '@repo/ui';

/**
 * The public seller profile (Phase 4-E, restyled in 0109).
 *
 * **A profile and nothing else in V1**: a name, the seller's own words, and the city they trade from. No
 * listings, no services, no ratings, no review count, no statistics, no verification badge and no contact
 * details — every one of those was explicitly excluded, and several of them never leave the database. 0109
 * changed how this page looks and added nothing to what it says; a "listings by this seller" grid would be a
 * new backend read, and a rating would be inventing data the product does not collect.
 *
 * **The layout is built for a page with three facts on it.** A profile this sparse looks unfinished in a wide
 * column, so the name, the avatar and the city sit together in a header block and the bio gets a measure it can
 * actually be read at. The avatar is the only place the seller's initial appears; it carries no image because
 * the contract has none.
 *
 * Direction is never hard-coded. Spacing uses logical properties, so the same markup reads correctly in English
 * and in Arabic with nothing but `dir` changing.
 */

export interface SellerLabels {
  readonly unavailable: string;
  readonly noDescription: string;
}

export function SellerProfileView({
  seller,
  availability,
  labels,
}: {
  readonly seller: PublicSellerProfile;
  readonly availability: SellerAvailability;
  readonly labels: SellerLabels;
}) {
  const unavailable = availability === 'unavailable';

  return (
    <article className="pt-6 pb-12">
      {unavailable ? (
        <div className="mb-6">
          <Alert tone="warning" announce="polite" title={labels.unavailable} />
        </div>
      ) : null}

      <header className="flex items-start gap-4">
        {/* The initial is taken as a whole grapheme, so an Arabic name is not cut in half. */}
        <Avatar name={seller.displayName} size="lg" />
        <div className="min-w-0 pt-1">
          <Heading level={1}>
            <span dir="auto">{seller.displayName}</span>
          </Heading>
          {seller.city === null ? null : <p className={cx('mt-2', TYPE.meta)}>{seller.city}</p>}
        </div>
      </header>

      <div className="mt-8 max-w-prose">
        {seller.bio === null ? (
          /*
            Not an apology and not a blank space: the page states that this seller has written nothing yet. A
            profile with no description is an ordinary state, so it is drawn as the quiet one-line empty state
            rather than as a failure.
          */
          <EmptyLine>{labels.noDescription}</EmptyLine>
        ) : (
          <Card padding="lg">
            {/*
              The bio is seller-written and never translated (D7), so it carries the language it was written in
              — a profile read in Arabic may hold an English bio, and a screen reader should switch voice for it
              rather than read it in the page's language. `dir="auto"` lays it out accordingly.
            */}
            <p
              {...(seller.contentLanguage === null ? {} : { lang: seller.contentLanguage })}
              dir="auto"
              className={cx('whitespace-pre-line', TYPE.prose)}
            >
              {seller.bio}
            </p>
          </Card>
        )}
      </div>
    </article>
  );
}
