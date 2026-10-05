import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  HomepageSectionConfigSchema,
  type HomepageCategoryCard,
  type HomepageListingCard,
  type HomepagePostCard,
  type HomepageSellerCard,
  type PublicHomepageSection,
  type PublicLocale,
} from '@repo/contracts';
import { CmsPublicUnavailableError } from './cms-errors.js';

/**
 * The public side of the homepage (0093).
 *
 * **This service composes; it decides nothing about visibility.** Which sections are active, which rows are still
 * purchasable, which sellers are still visible, which categories are still reachable and which posts are public
 * are all answered by the database, through the predicates that already own each question. This layer reads the
 * sections, asks for the content each one names, and assembles the two.
 *
 * **Owner decision C is applied here, once.** A resolver returns the rows that survived; a section left with none
 * of its content is dropped from the response entirely. That is why the public contract has no empty-section
 * state to render: an empty shelf never reaches a browser, so no renderer has to decide what one means.
 *
 * **Owner decision A is applied by absence.** Nothing in this file reads a promotion, a package, a placement, a
 * ranking setting or anything financial, and there is no code path that could: a featured section is the ids an
 * administrator chose, resolved live.
 *
 * **A malformed stored document costs one section, not the homepage.** Each section's `config` is checked against
 * its own type before it is used; one that does not match is skipped and logged. A single bad document must not
 * take the site's front page down with it.
 *
 * **`banner_strip` never arrives.** The database reader does not return one, and there is no branch here that
 * would know what to do with it — a banner is its image and this platform has no media origin.
 */

export const HOMEPAGE_PUBLIC_STORE = Symbol('HOMEPAGE_PUBLIC_STORE');

/** One row of `app_private.public_homepage_sections` (0093). */
export interface PublicHomepageSectionDbRow {
  readonly sectionId: string;
  readonly sectionKey: string;
  readonly sectionType: string;
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly sortOrder: number | string;
  readonly config: unknown;
}

/** One row of either listing reader (0093). The card fields a homepage card actually shows. */
export interface HomepageListingDbRow {
  readonly resultType: string;
  readonly slug: string;
  readonly title: string;
  readonly city: string | null;
  readonly priceMinor: string | number | null;
  readonly currencyCode: string;
  readonly currencyMinorUnit: number | string;
  readonly isNegotiable: boolean | null;
}

export interface HomepageCategoryDbRow {
  readonly slug: string;
  readonly name: string;
  readonly listingTypeCode: string | null;
  readonly icon: string | null;
}

export interface HomepageSellerDbRow {
  readonly slug: string;
  readonly displayName: string;
  readonly city: string | null;
  readonly bio: string | null;
}

export interface HomepagePostDbRow {
  readonly slug: string;
  readonly resolvedLocale: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly categorySlug: string | null;
  readonly categoryName: string | null;
  readonly publishedAt: Date | string;
}

export interface HomepagePublicStore {
  /** `app_private.public_homepage_sections(text)`: the active, served sections in order. */
  publicHomepageSections(locale: PublicLocale): Promise<readonly PublicHomepageSectionDbRow[]>;
  /** `app_private.public_homepage_listings(uuid[], integer)`: the chosen listings still visible, in order. */
  publicHomepageListings(input: {
    ids: readonly string[];
    limit: number;
  }): Promise<readonly HomepageListingDbRow[]>;
  /** `app_private.public_homepage_latest_listings(integer)`: the newest purchasable listings. */
  publicHomepageLatestListings(limit: number): Promise<readonly HomepageListingDbRow[]>;
  publicHomepageCategories(input: {
    ids: readonly string[];
    locale: PublicLocale;
    limit: number;
  }): Promise<readonly HomepageCategoryDbRow[]>;
  publicHomepageSellers(input: {
    ids: readonly string[];
    limit: number;
  }): Promise<readonly HomepageSellerDbRow[]>;
  publicHomepagePosts(input: { locale: PublicLocale; limit: number }): Promise<readonly HomepagePostDbRow[]>;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function toListingCard(row: HomepageListingDbRow): HomepageListingCard {
  return {
    resultType: row.resultType === 'service' ? 'service' : 'listing',
    slug: row.slug,
    title: row.title,
    city: row.city,
    // A minor amount is text all the way out: it is an exact integer that must never pass through a float.
    //
    // **No amount stays no amount.** `listings.price_minor` is nullable and a custom-priced service is the ordinary
    // case, so a null is carried as a null and the page says "contact for price" exactly as every other card on
    // this site does. Substituting `'0'` here would advertise a price the seller never set.
    priceMinor: row.priceMinor === null || row.priceMinor === undefined ? null : String(row.priceMinor),
    currencyCode: row.currencyCode,
    currencyMinorUnit: toNumber(row.currencyMinorUnit),
    isNegotiable: row.isNegotiable,
  };
}

@Injectable()
export class HomepagePublicService {
  private readonly logger = new Logger(HomepagePublicService.name);

  constructor(@Inject(HOMEPAGE_PUBLIC_STORE) private readonly store: HomepagePublicStore) {}

  /**
   * The homepage, assembled.
   *
   * A database that cannot answer is a 503 and never an empty homepage: showing a visitor a blank front page when
   * the truth is that we could not read it would be a wrong answer rather than an honest failure.
   */
  async compose(locale: PublicLocale): Promise<readonly PublicHomepageSection[]> {
    let rows: readonly PublicHomepageSectionDbRow[];
    try {
      rows = await this.store.publicHomepageSections(locale);
    } catch (error) {
      this.logger.error('The homepage sections could not be read.');
      throw new CmsPublicUnavailableError(error);
    }

    const sections: PublicHomepageSection[] = [];
    for (const row of rows) {
      // Checked against its own type before anything uses it. A document that does not match costs this one
      // section; the rest of the homepage is unaffected.
      const parsed = HomepageSectionConfigSchema.safeParse({
        sectionType: row.sectionType,
        config: row.config,
      });
      if (!parsed.success) {
        this.logger.warn(`Homepage section ${row.sectionKey} has a configuration its type does not accept.`);
        continue;
      }

      const section = await this.#resolve(row, parsed.data, locale);
      // Owner decision C: a section with nothing left to show is not in the response at all.
      if (section !== null) sections.push(section);
    }
    return sections;
  }

  async #resolve(
    row: PublicHomepageSectionDbRow,
    parsed: ReturnType<typeof HomepageSectionConfigSchema.parse>,
    locale: PublicLocale,
  ): Promise<PublicHomepageSection | null> {
    const shared = { sectionKey: row.sectionKey, title: row.title, subtitle: row.subtitle } as const;
    const arabic = locale === 'ar';

    try {
      switch (parsed.sectionType) {
        case 'hero': {
          const { lead, ctaLabel, ctaLabelAr, ctaPath } = parsed.config;
          // A hero has no rows to lose, so it is only dropped when it would say nothing at all — a section with
          // no title, no subtitle and no lead is an empty band rather than content.
          if (row.title === null && row.subtitle === null && lead === undefined) return null;
          return {
            sectionType: 'hero',
            ...shared,
            hero: {
              lead: lead ?? null,
              ctaLabel: (arabic ? ctaLabelAr ?? ctaLabel : ctaLabel) ?? null,
              ctaPath: ctaPath ?? null,
            },
          };
        }

        case 'featured_listings': {
          const ids = parsed.config.ids;
          if (ids.length === 0) return null;
          const found = await this.store.publicHomepageListings({ ids, limit: ids.length });
          return found.length === 0
            ? null
            : { sectionType: 'featured_listings', ...shared, listings: found.map(toListingCard) };
        }

        case 'latest_listings': {
          const found = await this.store.publicHomepageLatestListings(parsed.config.count);
          return found.length === 0
            ? null
            : { sectionType: 'latest_listings', ...shared, listings: found.map(toListingCard) };
        }

        case 'featured_categories': {
          const ids = parsed.config.ids;
          if (ids.length === 0) return null;
          const found = await this.store.publicHomepageCategories({ ids, locale, limit: ids.length });
          return found.length === 0
            ? null
            : {
                sectionType: 'featured_categories',
                ...shared,
                categories: found.map(
                  (entry): HomepageCategoryCard => ({
                    slug: entry.slug,
                    name: entry.name,
                    listingTypeCode: entry.listingTypeCode,
                    icon: entry.icon,
                  }),
                ),
              };
        }

        case 'featured_sellers': {
          const ids = parsed.config.ids;
          if (ids.length === 0) return null;
          const found = await this.store.publicHomepageSellers({ ids, limit: ids.length });
          return found.length === 0
            ? null
            : {
                sectionType: 'featured_sellers',
                ...shared,
                sellers: found.map(
                  (entry): HomepageSellerCard => ({
                    slug: entry.slug,
                    displayName: entry.displayName,
                    city: entry.city,
                    bio: entry.bio,
                  }),
                ),
              };
        }

        case 'blog_highlights': {
          const found = await this.store.publicHomepagePosts({ locale, limit: parsed.config.count });
          return found.length === 0
            ? null
            : {
                sectionType: 'blog_highlights',
                ...shared,
                posts: found.map(
                  (entry): HomepagePostCard => ({
                    slug: entry.slug,
                    resolvedLocale: entry.resolvedLocale as PublicLocale,
                    title: entry.title,
                    excerpt: entry.excerpt,
                    categorySlug: entry.categorySlug,
                    categoryName: entry.categoryName,
                    publishedAt: toIso(entry.publishedAt),
                  }),
                ),
              };
        }

        case 'value_props': {
          const items = parsed.config.items.map((item) => ({
            title: (arabic ? item.titleAr ?? item.titleEn : item.titleEn),
            body: (arabic ? item.bodyAr ?? item.bodyEn : item.bodyEn),
          }));
          return items.length === 0 ? null : { sectionType: 'value_props', ...shared, items };
        }

        case 'rich_text': {
          // Plain text, by owner decision D. Carried through as a string and never marked as markup.
          const body = arabic ? parsed.config.bodyAr ?? parsed.config.bodyEn : parsed.config.bodyEn;
          return body.trim() === '' ? null : { sectionType: 'rich_text', ...shared, body };
        }
      }
    } catch (error) {
      this.logger.error('A homepage section could not be read.');
      throw new CmsPublicUnavailableError(error);
    }
  }
}
