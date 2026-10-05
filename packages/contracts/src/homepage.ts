import { z } from './zod.js';
import { PublicLocaleSchema } from './categories.js';
import { MinorAmountSchema } from './listings.js';

/**
 * The homepage — what it is made of, and how a console authors it (Phase 8, increment 0093).
 *
 * **The configuration is a discriminated union, and that is the whole design.** 0030 constrains `config` only to
 * being a JSON object, which means every reader downstream would otherwise have to guess what a given section's
 * document holds. Here each `sectionType` has exactly one shape, the union discriminates on it, and every member
 * is strict — so a `featured_listings` carrying a `count`, or a `hero` carrying ids, is refused at the boundary
 * rather than silently ignored by whichever renderer happens to read it.
 *
 * **Owner decision A — featured means editorial.** A `featured_*` section is the ordered ids an administrator
 * chose and nothing else. There is no field anywhere in this file for a promotion, a package, a placement, a
 * ranking, a weight or a popularity signal, and no shape that could carry one: `promotion_package_placements`
 * already has a `homepage` placement and promotions are paid, so a field here would be the beginning of a
 * financial path, and 0089 records twice that promoted-result merging is a **Phase 9** decision.
 *
 * **Owner decision B — the three shapes.** Text for `hero`, `value_props` and `rich_text`; an ordered id array
 * with a maximum for the three `featured_*` types; a count for `latest_listings` and `blog_highlights`, because
 * "latest" is a query rather than a selection and an id list would freeze it.
 *
 * **Owner decision C — a section that has nothing left to show is skipped.** The public response therefore
 * carries each section's *resolved* content, and a section with none is absent from it: the web layer never has
 * to decide what an empty shelf means because an empty shelf never arrives.
 *
 * **Owner decision D — `rich_text` is text.** The field is `body`, it is a string, and nothing in the public
 * contract marks any part of it as markup.
 *
 * **`banner_strip` is not here.** It is one of 0030's nine types and stays legal in the database, but a banner is
 * its image and this platform has no media origin to address one with — so there is no config shape for it, no
 * resolved payload, and the public reader never returns one.
 *
 * Every response schema is strict. A value the database could not have produced means something upstream is
 * wrong, and silently accepting it is how an unnoticed field becomes a dependency.
 */

// ---------------------------------------------------------------------------------------------------
// Shared vocabulary — every value below is one the database already constrains
// ---------------------------------------------------------------------------------------------------
/** 0030's nine section types, as stored. `banner_strip` is legal and unserved. */
export const HOMEPAGE_SECTION_TYPES = [
  'hero',
  'banner_strip',
  'featured_listings',
  'featured_categories',
  'featured_sellers',
  'latest_listings',
  'blog_highlights',
  'value_props',
  'rich_text',
] as const;
export type HomepageSectionType = (typeof HOMEPAGE_SECTION_TYPES)[number];
export const HomepageSectionTypeSchema = z.enum(HOMEPAGE_SECTION_TYPES);

/**
 * The eight types this increment serves, which is what a console may author and what the public may receive.
 *
 * `banner_strip` is excluded for the reason the module comment gives. A section of that type that already exists
 * is still listed in the console — marked as one the homepage will not render — so nothing is hidden from an
 * operator; it simply cannot be created or served here.
 */
export const HOMEPAGE_SERVED_SECTION_TYPES = [
  'hero',
  'featured_listings',
  'featured_categories',
  'featured_sellers',
  'latest_listings',
  'blog_highlights',
  'value_props',
  'rich_text',
] as const;
export type HomepageServedSectionType = (typeof HOMEPAGE_SERVED_SECTION_TYPES)[number];
export const HomepageServedSectionTypeSchema = z.enum(HOMEPAGE_SERVED_SECTION_TYPES);

/** The key shape `homepage_sections_key_format` enforces, restated so a bad key is a 400 and never a 500. */
export const HOMEPAGE_SECTION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
export const HomepageSectionKeySchema = z.string().regex(HOMEPAGE_SECTION_KEY_PATTERN).max(64);

/** The lengths 0030's own constraints enforce. */
export const HOMEPAGE_TITLE_MAX = 160;

/** How many rows one curated section may name, and how many a counted section may ask for. */
export const HOMEPAGE_SECTION_IDS_MAX = 24;
export const HOMEPAGE_SECTION_COUNT_MAX = 24;

/** The lengths this contract sets for the text a section carries, which 0030 leaves to the application. */
export const HOMEPAGE_LEAD_MAX = 320;
export const HOMEPAGE_CTA_LABEL_MAX = 60;
export const HOMEPAGE_VALUE_PROP_MAX = 12;
export const HOMEPAGE_VALUE_PROP_TEXT_MAX = 240;
export const HOMEPAGE_RICH_TEXT_MAX = 4000;

/** A relative path, the same rule 0030 applies to a banner's link: a section can never point off the site. */
export const HOMEPAGE_PATH_PATTERN = /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/;
export const HomepagePathSchema = z.string().regex(HOMEPAGE_PATH_PATTERN).max(2048);

// ---------------------------------------------------------------------------------------------------
// The configuration shapes — one per served type, strict, discriminated on the type
// ---------------------------------------------------------------------------------------------------
/** An ordered selection. The order is the administrator's and the database preserves it exactly. */
const IdSelectionSchema = z
  .object({
    ids: z.array(z.string().uuid()).max(HOMEPAGE_SECTION_IDS_MAX),
  })
  .strict();

/** A count. `latest` is a query, so freezing it to a list of ids would defeat the point of the section. */
const CountSelectionSchema = z
  .object({
    count: z.number().int().min(1).max(HOMEPAGE_SECTION_COUNT_MAX),
  })
  .strict();

/** The hero's own text. Its title and subtitle are columns of the row; this is what else it says. */
export const HeroConfigSchema = z
  .object({
    lead: z.string().max(HOMEPAGE_LEAD_MAX).optional(),
    ctaLabel: z.string().max(HOMEPAGE_CTA_LABEL_MAX).optional(),
    ctaLabelAr: z.string().max(HOMEPAGE_CTA_LABEL_MAX).optional(),
    /** Relative by rule, so a hero can never send a visitor off the site. */
    ctaPath: HomepagePathSchema.optional(),
  })
  .strict();

export const ValuePropsConfigSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            titleEn: z.string().trim().min(1).max(HOMEPAGE_CTA_LABEL_MAX),
            titleAr: z.string().trim().min(1).max(HOMEPAGE_CTA_LABEL_MAX).optional(),
            bodyEn: z.string().trim().min(1).max(HOMEPAGE_VALUE_PROP_TEXT_MAX),
            bodyAr: z.string().trim().min(1).max(HOMEPAGE_VALUE_PROP_TEXT_MAX).optional(),
          })
          .strict(),
      )
      .max(HOMEPAGE_VALUE_PROP_MAX),
  })
  .strict();

/**
 * A block of prose.
 *
 * **Plain text, by owner decision D.** There is no `format` field and no `html` field, because there is no second
 * possibility: whatever is stored here is rendered as text, and a contract that admitted markup would be the
 * first half of a decision nobody made.
 */
export const RichTextConfigSchema = z
  .object({
    bodyEn: z.string().trim().min(1).max(HOMEPAGE_RICH_TEXT_MAX),
    bodyAr: z.string().trim().min(1).max(HOMEPAGE_RICH_TEXT_MAX).optional(),
  })
  .strict();

/**
 * One section's configuration, discriminated on its type.
 *
 * Strict on every member, so a shape that belongs to another type is a refusal rather than a field quietly
 * carried along. A section stores its type on the row and its document in `config`; this union is what joins the
 * two back together at the boundary.
 */
export const HomepageSectionConfigSchema = z.discriminatedUnion('sectionType', [
  z.object({ sectionType: z.literal('hero'), config: HeroConfigSchema }).strict(),
  z.object({ sectionType: z.literal('featured_listings'), config: IdSelectionSchema }).strict(),
  z.object({ sectionType: z.literal('featured_categories'), config: IdSelectionSchema }).strict(),
  z.object({ sectionType: z.literal('featured_sellers'), config: IdSelectionSchema }).strict(),
  z.object({ sectionType: z.literal('latest_listings'), config: CountSelectionSchema }).strict(),
  z.object({ sectionType: z.literal('blog_highlights'), config: CountSelectionSchema }).strict(),
  z.object({ sectionType: z.literal('value_props'), config: ValuePropsConfigSchema }).strict(),
  z.object({ sectionType: z.literal('rich_text'), config: RichTextConfigSchema }).strict(),
]);
export type HomepageSectionConfig = z.infer<typeof HomepageSectionConfigSchema>;

/**
 * Whether one stored document is the right shape for its type.
 *
 * Used by the console before a save and by the API before it serves a section, so an operator learns about a
 * malformed document from a form error and a visitor never sees a half-rendered shelf.
 */
export function homepageConfigIsValid(sectionType: string, config: unknown): boolean {
  return HomepageSectionConfigSchema.safeParse({ sectionType, config }).success;
}

// ---------------------------------------------------------------------------------------------------
// Public — the resolved homepage
// ---------------------------------------------------------------------------------------------------
/**
 * One listing or service card. 0089's own card fields: never the seller, the location or a view count.
 *
 * **`priceMinor` is nullable, exactly as {@link ListingSummarySchema}'s is.** `listings.price_minor` allows no
 * amount, and a service with `pricing_model = 'custom'` is precisely the case: it reaches a page as "contact for
 * price". A missing amount is therefore carried as `null` and never as `'0'` — a listing nobody priced and a
 * listing given away are different claims, and the front page is the last place to confuse them.
 *
 * `resultType` is here because the two kinds live at different paths. `pricingModel`, `deliveryDays` and
 * `revisionsIncluded` are not: a compact card shows none of them, and a public contract should carry nothing no
 * renderer reads.
 */
export const HomepageListingCardSchema = z
  .object({
    resultType: z.enum(['listing', 'service']),
    slug: z.string(),
    title: z.string(),
    city: z.string().nullable(),
    priceMinor: MinorAmountSchema.nullable(),
    currencyCode: z.string().length(3),
    currencyMinorUnit: z.number().int().min(0).max(4),
    // Null for a service: `is_negotiable` is a product's field and 0089's reader says so rather than inventing a
    // `false` for a row that never had the column's meaning.
    isNegotiable: z.boolean().nullable(),
  })
  .strict();
export type HomepageListingCard = z.infer<typeof HomepageListingCardSchema>;

export const HomepageCategoryCardSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    listingTypeCode: z.string().nullable(),
    icon: z.string().nullable(),
  })
  .strict();
export type HomepageCategoryCard = z.infer<typeof HomepageCategoryCardSchema>;

/** A seller card with no logo or banner: there is no media origin to address one with. */
export const HomepageSellerCardSchema = z
  .object({
    slug: z.string(),
    displayName: z.string(),
    city: z.string().nullable(),
    bio: z.string().nullable(),
  })
  .strict();
export type HomepageSellerCard = z.infer<typeof HomepageSellerCardSchema>;

export const HomepagePostCardSchema = z
  .object({
    slug: z.string(),
    resolvedLocale: PublicLocaleSchema,
    title: z.string(),
    excerpt: z.string().nullable(),
    categorySlug: z.string().nullable(),
    categoryName: z.string().nullable(),
    publishedAt: z.string(),
  })
  .strict();
export type HomepagePostCard = z.infer<typeof HomepagePostCardSchema>;

/** The text a hero shows, already resolved to the requested locale. */
export const HomepageHeroContentSchema = z
  .object({
    lead: z.string().nullable(),
    ctaLabel: z.string().nullable(),
    ctaPath: z.string().nullable(),
  })
  .strict();

export const HomepageValuePropSchema = z
  .object({ title: z.string(), body: z.string() })
  .strict();

/**
 * One section as the public receives it: the row's own title and subtitle, plus the content it resolved to.
 *
 * A discriminated union again, so a renderer branches once on `sectionType` and then holds exactly the payload
 * that type carries. **A section whose content all disappeared is not in the response at all** (owner decision
 * C), which is why no member here has an "empty" state to handle.
 */
export const PublicHomepageSectionSchema = z.discriminatedUnion('sectionType', [
  z
    .object({
      sectionType: z.literal('hero'),
      sectionKey: HomepageSectionKeySchema,
      title: z.string().nullable(),
      subtitle: z.string().nullable(),
      hero: HomepageHeroContentSchema,
    })
    .strict(),
  z
    .object({
      sectionType: z.literal('featured_listings'),
      sectionKey: HomepageSectionKeySchema,
      title: z.string().nullable(),
      subtitle: z.string().nullable(),
      listings: z.array(HomepageListingCardSchema).min(1),
    })
    .strict(),
  z
    .object({
      sectionType: z.literal('latest_listings'),
      sectionKey: HomepageSectionKeySchema,
      title: z.string().nullable(),
      subtitle: z.string().nullable(),
      listings: z.array(HomepageListingCardSchema).min(1),
    })
    .strict(),
  z
    .object({
      sectionType: z.literal('featured_categories'),
      sectionKey: HomepageSectionKeySchema,
      title: z.string().nullable(),
      subtitle: z.string().nullable(),
      categories: z.array(HomepageCategoryCardSchema).min(1),
    })
    .strict(),
  z
    .object({
      sectionType: z.literal('featured_sellers'),
      sectionKey: HomepageSectionKeySchema,
      title: z.string().nullable(),
      subtitle: z.string().nullable(),
      sellers: z.array(HomepageSellerCardSchema).min(1),
    })
    .strict(),
  z
    .object({
      sectionType: z.literal('blog_highlights'),
      sectionKey: HomepageSectionKeySchema,
      title: z.string().nullable(),
      subtitle: z.string().nullable(),
      posts: z.array(HomepagePostCardSchema).min(1),
    })
    .strict(),
  z
    .object({
      sectionType: z.literal('value_props'),
      sectionKey: HomepageSectionKeySchema,
      title: z.string().nullable(),
      subtitle: z.string().nullable(),
      items: z.array(HomepageValuePropSchema).min(1),
    })
    .strict(),
  z
    .object({
      sectionType: z.literal('rich_text'),
      sectionKey: HomepageSectionKeySchema,
      title: z.string().nullable(),
      subtitle: z.string().nullable(),
      /** Plain text. Rendered as text, never as markup (owner decision D). */
      body: z.string(),
    })
    .strict(),
]);
export type PublicHomepageSection = z.infer<typeof PublicHomepageSectionSchema>;

export const PublicHomepageResponseSchema = z
  .object({ sections: z.array(PublicHomepageSectionSchema) })
  .strict();
export type PublicHomepageResponse = z.infer<typeof PublicHomepageResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------------------------------
export const HomepageSectionSummarySchema = z
  .object({
    id: z.string().uuid(),
    sectionKey: HomepageSectionKeySchema,
    sectionType: HomepageSectionTypeSchema,
    titleEn: z.string().nullable(),
    titleAr: z.string().nullable(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
    /** False for a section the public homepage will not render — today, only a `banner_strip`. */
    isServed: z.boolean(),
    /** False when the stored document is not the right shape for this type. */
    isConfigured: z.boolean(),
    updatedAt: z.string(),
  })
  .strict();
export type HomepageSectionSummary = z.infer<typeof HomepageSectionSummarySchema>;

export const HomepageSectionsResponseSchema = z
  .object({
    sections: z.array(HomepageSectionSummarySchema),
    /** Whether this caller may change any of it, for the same reason every other detail reports it. */
    canManage: z.boolean(),
  })
  .strict();
export type HomepageSectionsResponse = z.infer<typeof HomepageSectionsResponseSchema>;

export const HomepageSectionDetailSchema = z
  .object({
    id: z.string().uuid(),
    sectionKey: HomepageSectionKeySchema,
    sectionType: HomepageSectionTypeSchema,
    titleEn: z.string().nullable(),
    titleAr: z.string().nullable(),
    subtitleEn: z.string().nullable(),
    subtitleAr: z.string().nullable(),
    /** The document as stored. The console validates it against this type's shape before offering a save. */
    config: z.unknown(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
    isServed: z.boolean(),
    isConfigured: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    canManage: z.boolean(),
    /** How many rows this section names, for a type that names any. */
    chosenCount: z.number().int().min(0),
    /**
     * How many of those are still renderable. Owner decision C made visible: a section whose rows have all gone
     * is skipped on the public homepage, and this is where an operator finds out why.
     */
    renderableCount: z.number().int().min(0),
  })
  .strict();
export type HomepageSectionDetail = z.infer<typeof HomepageSectionDetailSchema>;

export const HomepageSectionDetailResponseSchema = z
  .object({ section: HomepageSectionDetailSchema })
  .strict();
export type HomepageSectionDetailResponse = z.infer<typeof HomepageSectionDetailResponseSchema>;

/**
 * Creating a section.
 *
 * The type and its config are validated together, so a shape that belongs to another type never reaches the
 * database. A section is always created hidden, so there is no `isActive` here to set.
 */
export const CreateHomepageSectionRequestSchema = z
  .object({
    sectionKey: HomepageSectionKeySchema,
    sectionType: HomepageServedSectionTypeSchema,
    titleEn: z.string().trim().min(1).max(HOMEPAGE_TITLE_MAX).nullable().optional(),
    titleAr: z.string().trim().min(1).max(HOMEPAGE_TITLE_MAX).nullable().optional(),
    subtitleEn: z.string().trim().min(1).max(HOMEPAGE_TITLE_MAX).nullable().optional(),
    subtitleAr: z.string().trim().min(1).max(HOMEPAGE_TITLE_MAX).nullable().optional(),
    config: z.unknown(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!homepageConfigIsValid(value.sectionType, value.config)) {
      ctx.addIssue({
        code: 'custom',
        path: ['config'],
        message: 'the configuration does not match the section type',
      });
    }
  });
export type CreateHomepageSectionRequest = z.infer<typeof CreateHomepageSectionRequestSchema>;

export const CreateHomepageSectionResponseSchema = z.object({ id: z.string().uuid() }).strict();
export type CreateHomepageSectionResponse = z.infer<typeof CreateHomepageSectionResponseSchema>;

/**
 * Changing a section.
 *
 * `isActive` is deliberately absent: showing a section has its own request, so editing its text can never put a
 * half-configured section in front of the public. When a `config` is sent, the `sectionType` must come with it —
 * the two are validated as a pair, and a config without its type could not be checked against anything.
 */
export const UpdateHomepageSectionRequestSchema = z
  .object({
    sectionKey: HomepageSectionKeySchema.optional(),
    sectionType: HomepageServedSectionTypeSchema.optional(),
    titleEn: z.string().trim().min(1).max(HOMEPAGE_TITLE_MAX).nullable().optional(),
    titleAr: z.string().trim().min(1).max(HOMEPAGE_TITLE_MAX).nullable().optional(),
    subtitleEn: z.string().trim().min(1).max(HOMEPAGE_TITLE_MAX).nullable().optional(),
    subtitleAr: z.string().trim().min(1).max(HOMEPAGE_TITLE_MAX).nullable().optional(),
    config: z.unknown().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .superRefine((value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'at least one field must be present' });
      return;
    }
    if ('config' in value) {
      if (value.sectionType === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['sectionType'],
          message: 'a configuration can only be checked against a section type',
        });
        return;
      }
      if (!homepageConfigIsValid(value.sectionType, value.config)) {
        ctx.addIssue({
          code: 'custom',
          path: ['config'],
          message: 'the configuration does not match the section type',
        });
      }
    }
  });
export type UpdateHomepageSectionRequest = z.infer<typeof UpdateHomepageSectionRequestSchema>;

/** Showing or hiding one section. The only request that can put one in front of the public. */
export const HomepageSectionStateRequestSchema = z.object({ isActive: z.boolean() }).strict();
export type HomepageSectionStateRequest = z.infer<typeof HomepageSectionStateRequestSchema>;

/** The order the sections should hold, sent whole for the reason the blog's tag set is. */
export const ReorderHomepageSectionsRequestSchema = z
  .object({ sectionIds: z.array(z.string().uuid()).max(100) })
  .strict();
export type ReorderHomepageSectionsRequest = z.infer<typeof ReorderHomepageSectionsRequestSchema>;

export const HomepageWriteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type HomepageWriteResponse = z.infer<typeof HomepageWriteResponseSchema>;
