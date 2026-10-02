import { z } from './zod.js';
import { PublicLocaleSchema } from './categories.js';

/**
 * The category tree as the admin console works with it.
 *
 * `categories` and `category_translations` have existed since migration 0010 with public readers over them and
 * no way to write one. This is that surface. Everything here is shaped by a constraint that already exists:
 * the limits below are read off 0010, not chosen.
 *
 * **The slug is absent from every request but the create.** It is the category's public address, there is no
 * `category_slug_history` and the public reader has no `moved` answer, so a rename would break a live address
 * with no redirect. Making it unexpressible is the difference between a rule and a hope (owner decision).
 *
 * **The active state is absent from the create and the update.** It has its own request, because showing or
 * hiding a category is the one edit a visitor sees, and it should never happen as a side effect of renaming
 * something. A new category is always created hidden.
 *
 * **`depth` is read-only everywhere.** The tree trigger in 0010 derives it from the parent and refuses a fourth
 * level; a request that carried a depth would be asking to be believed about the shape of the tree.
 */

// ---------------------------------------------------------------------------------------------------
// Limits, each one read off a constraint in migration 0010
// ---------------------------------------------------------------------------------------------------
/** `categories_slug_format`: one lowercase slug, 1–80 characters. */
export const CATEGORY_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
export const CategorySlugSchema = z.string().regex(CATEGORY_SLUG_PATTERN);

/** `categories_depth_range`: depth 0, 1 or 2 — D8's three levels. */
export const CATEGORY_MAX_DEPTH = 2;
export const CATEGORY_LEVELS = CATEGORY_MAX_DEPTH + 1;

/** `category_translations_name_length`, `_meta_title_length`, `_meta_description_length`. */
export const CATEGORY_NAME_MAX = 120;
export const CATEGORY_META_TITLE_MAX = 70;
export const CATEGORY_META_DESCRIPTION_MAX = 320;

/**
 * The description has no length constraint in 0010, so this bound is the contract's own and exists only to keep
 * a request from being unbounded. It is deliberately generous: nothing depends on the exact number, and a tighter
 * limit would be inventing an editorial rule nobody wrote.
 */
export const CATEGORY_DESCRIPTION_MAX = 4000;

/** `listing_types`: the two seeded surfaces a category can belong to. A category may belong to neither. */
export const CATEGORY_LISTING_TYPES = ['product', 'service'] as const;
export type CategoryListingType = (typeof CATEGORY_LISTING_TYPES)[number];
export const CategoryListingTypeSchema = z.enum(CATEGORY_LISTING_TYPES);

/** `categories.sort_order` is an integer; these bounds keep a request inside one. */
export const CATEGORY_SORT_ORDER_MIN = 0;
export const CATEGORY_SORT_ORDER_MAX = 2_147_483_647;

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------
/**
 * One node of the tree as the console lists it.
 *
 * `isVisible` is the **public** answer, carried separately from `isActive`, because the two differ exactly when
 * an active category sits under a hidden ancestor — the state an author most needs to see and the one a row
 * cannot report about itself.
 *
 * `translatedLocales` is the locale coverage. `childCount` and `listingCount` are what decide whether a move or
 * a hide is safe to offer, so they travel with the row rather than being counted again by a screen.
 */
export const AdminCategoryNodeSchema = z.object({
  categoryId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  slug: CategorySlugSchema,
  depth: z.number().int().min(0).max(CATEGORY_MAX_DEPTH),
  sortOrder: z.number().int(),
  listingTypeCode: CategoryListingTypeSchema.nullable(),
  isActive: z.boolean(),
  isVisible: z.boolean(),
  childCount: z.number().int().min(0),
  listingCount: z.number().int().min(0),
  translatedLocales: z.array(PublicLocaleSchema),
  /** The name in the default locale, or `null` for a category nobody has written yet. */
  name: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export type AdminCategoryNode = z.infer<typeof AdminCategoryNodeSchema>;

export const AdminCategoryTreeResponseSchema = z.object({
  categories: z.array(AdminCategoryNodeSchema),
});
export type AdminCategoryTreeResponse = z.infer<typeof AdminCategoryTreeResponseSchema>;

/** One category in full. `canManage` is the server's answer, which is what a console renders its controls from. */
export const AdminCategoryDetailSchema = AdminCategoryNodeSchema.omit({ name: true }).extend({
  parentSlug: CategorySlugSchema.nullable(),
  createdAt: z.string().datetime(),
  canManage: z.boolean(),
});
export type AdminCategoryDetail = z.infer<typeof AdminCategoryDetailSchema>;

export const AdminCategoryTranslationSchema = z.object({
  localeCode: PublicLocaleSchema,
  name: z.string().min(1).max(CATEGORY_NAME_MAX),
  description: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export type AdminCategoryTranslation = z.infer<typeof AdminCategoryTranslationSchema>;

export const AdminCategoryDetailResponseSchema = z.object({
  category: AdminCategoryDetailSchema,
  translations: z.array(AdminCategoryTranslationSchema),
});
export type AdminCategoryDetailResponse = z.infer<typeof AdminCategoryDetailResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------
/**
 * Create one category.
 *
 * The slug is given here and never again. There is no `isActive`: a new category is always hidden, because 0045
 * falls back to the slug when no translation exists and an unnamed category would otherwise appear in the public
 * tree labelled `winter-coats`.
 */
export const CreateCategoryRequestSchema = z
  .object({
    slug: CategorySlugSchema,
    parentId: z.string().uuid().nullable().optional(),
    listingTypeCode: CategoryListingTypeSchema.nullable().optional(),
    sortOrder: z.number().int().min(CATEGORY_SORT_ORDER_MIN).max(CATEGORY_SORT_ORDER_MAX).optional(),
  })
  .strict();
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequestSchema>;

export const CreateCategoryResponseSchema = z.object({ categoryId: z.string().uuid() });
export type CreateCategoryResponse = z.infer<typeof CreateCategoryResponseSchema>;

/**
 * Change a category's parent, surface and ordering.
 *
 * **`setParent` exists because `null` is a real parent**: it means a root. Without the flag, "move this to the
 * root" and "leave the parent alone" would be the same request, and one of them would silently win.
 *
 * `slug` and `isActive` are absent, and `.strict()` makes sending either a validation failure rather than a value
 * quietly dropped.
 */
export const UpdateCategoryRequestSchema = z
  .object({
    setParent: z.boolean(),
    parentId: z.string().uuid().nullable().optional(),
    listingTypeCode: CategoryListingTypeSchema.nullable().optional(),
    sortOrder: z.number().int().min(CATEGORY_SORT_ORDER_MIN).max(CATEGORY_SORT_ORDER_MAX).optional(),
  })
  .strict()
  .refine((value) => value.setParent || value.parentId === undefined || value.parentId === null, {
    message: 'a parent can only be set when setParent is true',
    path: ['parentId'],
  });
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequestSchema>;

/** Show or hide one category. Its own request, because this is the one edit a visitor sees. */
export const CategoryStateRequestSchema = z.object({ isActive: z.boolean() }).strict();
export type CategoryStateRequest = z.infer<typeof CategoryStateRequestSchema>;

/**
 * Write one locale of one category.
 *
 * `name` is required because 0010 says `not null`. The three optional fields accept an empty string, which
 * **clears** them: a description nobody wrote and one somebody cleared are the same state, and the writer stores
 * a blank as null so an empty meta title never renders as an empty tag.
 */
export const SaveCategoryTranslationRequestSchema = z
  .object({
    name: z.string().min(1).max(CATEGORY_NAME_MAX),
    description: z.string().max(CATEGORY_DESCRIPTION_MAX).optional(),
    metaTitle: z.string().max(CATEGORY_META_TITLE_MAX).optional(),
    metaDescription: z.string().max(CATEGORY_META_DESCRIPTION_MAX).optional(),
  })
  .strict();
export type SaveCategoryTranslationRequest = z.infer<typeof SaveCategoryTranslationRequestSchema>;

/** Every write answers the same way: whether it changed anything. */
export const CategoryWriteResponseSchema = z.object({ changed: z.boolean() });
export type CategoryWriteResponse = z.infer<typeof CategoryWriteResponseSchema>;
