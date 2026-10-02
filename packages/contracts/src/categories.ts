import { z } from './zod.js';

/**
 * The public category tree (Phase 4-A).
 *
 * The first contract in this system a guest can reach. It is deliberately the smallest thing that can
 * render a category page: four fields per node and nothing else. No count, no icon, no image, no SEO
 * text, no active flag — the reader behind it does not even select them.
 *
 * There is no request body, no pagination, no filter and no sort. The only input is the locale, which
 * chooses a *representation* of the same tree rather than a subset of it: `/categories` and
 * `/ar/categories` always show the same categories, named differently.
 */

/** The locales the public site serves: English at the root, Arabic under `/ar` (D6). */
export const PUBLIC_LOCALES = ['en', 'ar'] as const;
export type PublicLocale = (typeof PUBLIC_LOCALES)[number];

/** The locale the root serves, and the fallback for every name the requested locale lacks. */
export const DEFAULT_PUBLIC_LOCALE: PublicLocale = 'en';

export const PublicLocaleSchema = z.enum(PUBLIC_LOCALES);

/**
 * One node of the tree.
 *
 * `children` is the only recursive part, and the database limits the tree to three levels (D8), so the
 * nesting a client must handle is bounded even though the type is not.
 */
export interface CategoryNode {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly children: readonly CategoryNode[];
}

/**
 * The node is recursive, which OpenAPI expresses with a `$ref` to itself and a Zod generator cannot
 * walk. So `children` carries an explicit document shape: validation still recurses through the lazy
 * schema, while the generated document emits the self-reference instead of trying to expand it
 * forever. One schema, two readers.
 */
export const CategoryNodeSchema: z.ZodType<CategoryNode> = z
  .lazy(() =>
    z
      .object({
        id: z.uuid(),
        slug: z.string().min(1),
        name: z.string().min(1),
        children: z
          .array(CategoryNodeSchema)
          .openapi({ type: 'array', items: { $ref: '#/components/schemas/CategoryNode' } }),
      })
      .strict(),
  )
  .openapi('CategoryNode');

/**
 * The response.
 *
 * `categories` holds the roots; everything else hangs off them. An empty array is a valid, successful
 * answer — a catalogue with nothing published yet is not an error, and the page has an empty state for
 * exactly that.
 */
export const CategoriesResponseSchema = z
  .object({
    categories: z.array(CategoryNodeSchema),
  })
  .strict()
  .openapi('CategoriesResponse');

export type CategoriesResponse = z.infer<typeof CategoriesResponseSchema>;

/**
 * One category as its landing page sees it (Phase 4-D).
 *
 * A different shape from {@link CategoryNodeSchema} and deliberately so: the tree is recursive because
 * it *is* the whole catalogue, while a landing page is one category with one step in each direction —
 * the parent above it and its direct children below. Nothing recurses, so nothing here needs the lazy
 * schema the tree needs.
 *
 * `description` is the only free text the page shows. The SEO fields the reader also returns
 * (`meta_title`, `meta_description`) are **not** part of this contract: they are used server-side to
 * build the document head and never rendered as page content, so they never travel to a browser.
 */
export const CategoryLinkSchema = z
  .object({
    id: z.uuid(),
    slug: z.string().min(1),
    name: z.string().min(1),
  })
  .strict()
  .openapi('CategoryLink');

export const CategoryDetailSchema = z
  .object({
    id: z.uuid(),
    slug: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable(),
    parent: CategoryLinkSchema.nullable(),
    children: z.array(CategoryLinkSchema),
  })
  .strict()
  .openapi('CategoryDetail');

/**
 * The document head fields, kept in their own object rather than folded into the category.
 *
 * They travel **internally only** — API to BFF to the server component that builds the `<head>`. The
 * browser-facing document ({@link PublicCategoryResponseSchema}) has no `seo` key at all, so page
 * metadata cannot leak into the page body by a careless spread.
 */
export const CategorySeoSchema = z
  .object({
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
  })
  .strict()
  .openapi('CategorySeo');

/** The internal API response: the category plus the head fields. */
export const CategoryDetailResponseSchema = z
  .object({
    category: CategoryDetailSchema,
    seo: CategorySeoSchema,
  })
  .strict()
  .openapi('CategoryDetailResponse');

/** What the browser is given. No `seo`: those fields are for the document head, not for a client. */
export const PublicCategoryResponseSchema = z
  .object({
    category: CategoryDetailSchema,
  })
  .strict()
  .openapi('PublicCategoryResponse');

export type CategoryLink = z.infer<typeof CategoryLinkSchema>;
export type CategoryDetail = z.infer<typeof CategoryDetailSchema>;
export type CategorySeo = z.infer<typeof CategorySeoSchema>;
export type CategoryDetailResponse = z.infer<typeof CategoryDetailResponseSchema>;
export type PublicCategoryResponse = z.infer<typeof PublicCategoryResponseSchema>;

/**
 * The query parameter that selects the locale.
 *
 * Absent or unrecognised resolves to the default rather than failing: the approved status set for this
 * endpoint is 200, 500 and 503, so a locale a client cannot spell must not become a fourth outcome.
 */
export const CategoriesQuerySchema = z
  .object({
    locale: PublicLocaleSchema.optional(),
  })
  .strict()
  .openapi('CategoriesQuery');

export type CategoriesQuery = z.infer<typeof CategoriesQuerySchema>;

/** Resolves any client-supplied value to a locale this API serves. Never throws. */
export function publicLocaleOf(value: unknown): PublicLocale {
  if (typeof value !== 'string') return DEFAULT_PUBLIC_LOCALE;
  const normalized = value.trim().toLowerCase();
  return (PUBLIC_LOCALES as readonly string[]).includes(normalized)
    ? (normalized as PublicLocale)
    : DEFAULT_PUBLIC_LOCALE;
}
