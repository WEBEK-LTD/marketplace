import { z } from './zod.js';
import { PublicLocaleSchema } from './categories.js';

/**
 * Navigation — what a menu is made of, and how a console authors it (Phase 8, increment 0094).
 *
 * **The two-level limit is in the type, not in a check.** 0030's trigger refuses a third level in the database;
 * here a menu holds items and an item holds *links*, which hold no children of their own. A third level is
 * therefore unrepresentable rather than merely rejected, and no renderer has to decide what to do with one
 * (owner decision 5).
 *
 * **A target is a discriminated union, and that is the whole design.** 0030's CHECK says exactly one of
 * `page_id`, `blog_post_id`, `category_id` and `path` is filled, matching `target_kind`. A flat object with four
 * nullable fields would let a `path` item carry a page id and leave every reader to guess; the union makes the
 * constraint a shape, so the boundary refuses what the database would refuse.
 *
 * **The public response carries a slug, not an address, for the three id-bearing kinds.** The closed set of
 * served page addresses and the shape of a category or post URL are the *web application's* route map
 * (`@repo/config`), not a database fact. So the API hands over `slug` and the surface that owns the route map
 * derives the href and drops what it cannot serve — owner decision 4, applied in the one place that can apply
 * it, without reopening 0085 or introducing arbitrary page routing.
 *
 * **Owner decision 3 is why a menu here is never empty.** An item whose target is not public is omitted
 * upstream, a child whose parent went with it is omitted too, and a menu left with nothing does not appear.
 * `items` is therefore `.min(1)`: an empty menu is unrepresentable, so no renderer has to decide whether an
 * empty strip means "loading", "broken" or "nothing".
 *
 * **Every bound below is 0030's own**: the key format, the 120-character labels, the four target kinds and the
 * relative-path rule. Nothing here invents a limit, and nothing here is laxer than the column it describes.
 */

// ---------------------------------------------------------------------------------------------------
// Shared vocabulary — every value below is one the database already constrains
// ---------------------------------------------------------------------------------------------------
/**
 * The three menu keys this increment places (owner decision 1).
 *
 * `navigation_menus.menu_key` is free-form in 0030 (`^[a-z][a-z0-9_]*$`), so a menu stored under any other key
 * stays legal and simply has no public reader. Placement is deliberately not discovered dynamically.
 */
export const NAVIGATION_MENU_KEYS = ['header', 'footer', 'mobile'] as const;
export type NavigationMenuKey = (typeof NAVIGATION_MENU_KEYS)[number];
export const NavigationMenuKeySchema = z.enum(NAVIGATION_MENU_KEYS);

/** 0030's key format, which a console may author any menu under — served or not. */
export const NAVIGATION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
export const NavigationStoredMenuKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(NAVIGATION_KEY_PATTERN, 'a menu key is lowercase letters, digits and underscores');

/** 0030's four target kinds. */
export const NAVIGATION_TARGET_KINDS = ['page', 'blog_post', 'category', 'path'] as const;
export type NavigationTargetKind = (typeof NAVIGATION_TARGET_KINDS)[number];
export const NavigationTargetKindSchema = z.enum(NAVIGATION_TARGET_KINDS);

/**
 * What the database found at the other end of an item.
 *
 * `not_public` and `missing` are kept apart because an operator needs the difference: one is a page somebody
 * unpublished and the other is a row that no longer exists. Only the console ever sees either — the public
 * response has no state, because an item that is not `public` is not in it.
 */
export const NAVIGATION_TARGET_STATES = ['public', 'not_public', 'missing'] as const;
export type NavigationTargetState = (typeof NAVIGATION_TARGET_STATES)[number];
export const NavigationTargetStateSchema = z.enum(NAVIGATION_TARGET_STATES);

/** 0030's label length, for both languages. */
export const NAVIGATION_LABEL_MAX = 120;

/** How many items one reorder may name. A menu nobody can read is not a menu; this is a sanity bound. */
export const NAVIGATION_REORDER_MAX = 200;

/**
 * 0030's relative-path rule, as a schema.
 *
 * `banners_link_path_is_relative` and `navigation_items_path_is_relative` are the same rule and the same reason:
 * **a menu entry can never point off this site.** The second clause refuses a protocol-relative `//evil.example`,
 * which the first would otherwise admit.
 */
export const NavigationPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^\/[A-Za-z0-9/_\-?=&.%]*$/, 'a path is relative and starts with a single slash')
  .refine((value) => !value.startsWith('//'), 'a path may not be protocol-relative');

const LabelSchema = z.string().trim().min(1).max(NAVIGATION_LABEL_MAX);

// ---------------------------------------------------------------------------------------------------
// Public — the resolved menus
// ---------------------------------------------------------------------------------------------------
/**
 * Where one entry points, as the public receives it.
 *
 * Three of the four kinds carry a `slug` and the fourth carries a `path`. No kind carries an href: see the
 * module comment — deriving one is the route map's job.
 */
export const PublicNavigationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), slug: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('blog_post'), slug: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('category'), slug: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('path'), path: NavigationPathSchema }).strict(),
]);
export type PublicNavigationTarget = z.infer<typeof PublicNavigationTargetSchema>;

/** One link: the operator's own words and where they lead. A link holds no children — see the module comment. */
export const PublicNavigationLinkSchema = z
  .object({
    itemId: z.string().uuid(),
    label: z.string().min(1),
    target: PublicNavigationTargetSchema,
    /** Owner decision 6. Every path is relative, so a new tab is always same-site. */
    opensInNewTab: z.boolean(),
  })
  .strict();
export type PublicNavigationLink = z.infer<typeof PublicNavigationLinkSchema>;

/** One top-level entry, with the second level beneath it where there is one. */
export const PublicNavigationItemSchema = PublicNavigationLinkSchema.extend({
  children: z.array(PublicNavigationLinkSchema),
}).strict();
export type PublicNavigationItem = z.infer<typeof PublicNavigationItemSchema>;

/**
 * One menu the public site places.
 *
 * `items` is non-empty by contract: owner decision 3 drops an empty menu upstream, so an empty one arriving here
 * would mean something is wrong rather than that there is nothing to show.
 */
export const PublicNavigationMenuSchema = z
  .object({
    menuKey: NavigationMenuKeySchema,
    label: z.string().min(1),
    items: z.array(PublicNavigationItemSchema).min(1),
  })
  .strict();
export type PublicNavigationMenu = z.infer<typeof PublicNavigationMenuSchema>;

export const PublicNavigationResponseSchema = z
  .object({ menus: z.array(PublicNavigationMenuSchema) })
  .strict();
export type PublicNavigationResponse = z.infer<typeof PublicNavigationResponseSchema>;

/** The locale a menu was asked for, shared with every other public reader. */
export const NavigationLocaleSchema = PublicLocaleSchema;

// ---------------------------------------------------------------------------------------------------
// Authoring — menus
// ---------------------------------------------------------------------------------------------------
export const NavigationMenuSummarySchema = z
  .object({
    id: z.string().uuid(),
    menuKey: NavigationStoredMenuKeySchema,
    labelEn: z.string().min(1),
    labelAr: z.string().nullable(),
    isActive: z.boolean(),
    /** False for a menu the public site does not place — any key outside the three (owner decision 1). */
    isServed: z.boolean(),
    itemCount: z.number().int().min(0),
    /**
     * How many of those the public would be shown. Owner decision 3 made visible: a menu whose targets have all
     * been unpublished is skipped, and this is where an operator finds out why.
     */
    renderableItemCount: z.number().int().min(0),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type NavigationMenuSummary = z.infer<typeof NavigationMenuSummarySchema>;

export const NavigationMenusResponseSchema = z
  .object({
    menus: z.array(NavigationMenuSummarySchema),
    /** Whether this caller may change any of it, for the same reason every other console surface reports it. */
    canManage: z.boolean(),
  })
  .strict();
export type NavigationMenusResponse = z.infer<typeof NavigationMenusResponseSchema>;

/**
 * One item as the console sees it.
 *
 * Everything the public reader drops is here, with `targetState` saying why — owner decision 3's requirement
 * that unavailable targets stay visible to an operator. `targetSlug` is here for the same reason: a published
 * page whose slug is outside the application's served set is reported, and the console is where that is shown.
 */
export const NavigationItemSchema = z
  .object({
    id: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    depth: z.union([z.literal(1), z.literal(2)]),
    labelEn: z.string().min(1),
    labelAr: z.string().nullable(),
    targetKind: NavigationTargetKindSchema,
    pageId: z.string().uuid().nullable(),
    blogPostId: z.string().uuid().nullable(),
    categoryId: z.string().uuid().nullable(),
    path: z.string().nullable(),
    /** The target's own slug, where it has one. Never shown to the public as words. */
    targetSlug: z.string().nullable(),
    /** The target's own title, so an operator can recognise the row being pointed at. */
    targetTitle: z.string().nullable(),
    targetState: NavigationTargetStateSchema,
    opensInNewTab: z.boolean(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type NavigationItem = z.infer<typeof NavigationItemSchema>;

export const NavigationMenuDetailSchema = NavigationMenuSummarySchema.extend({
  canManage: z.boolean(),
  items: z.array(NavigationItemSchema),
}).strict();
export type NavigationMenuDetail = z.infer<typeof NavigationMenuDetailSchema>;

export const NavigationMenuDetailResponseSchema = z
  .object({ menu: NavigationMenuDetailSchema })
  .strict();
export type NavigationMenuDetailResponse = z.infer<typeof NavigationMenuDetailResponseSchema>;

/**
 * Creating a menu.
 *
 * `isActive` is deliberately absent: 0030 defaults a menu to active and showing or hiding one is its own
 * request, so creating a menu can never be how a half-built one reaches the public — a menu with no renderable
 * item is skipped anyway (owner decision 3).
 */
export const CreateNavigationMenuRequestSchema = z
  .object({
    menuKey: NavigationStoredMenuKeySchema,
    labelEn: LabelSchema,
    labelAr: LabelSchema.nullable().optional(),
  })
  .strict();
export type CreateNavigationMenuRequest = z.infer<typeof CreateNavigationMenuRequestSchema>;

export const CreateNavigationMenuResponseSchema = z.object({ id: z.string().uuid() }).strict();
export type CreateNavigationMenuResponse = z.infer<typeof CreateNavigationMenuResponseSchema>;

export const UpdateNavigationMenuRequestSchema = z
  .object({
    menuKey: NavigationStoredMenuKeySchema.optional(),
    labelEn: LabelSchema.optional(),
    labelAr: LabelSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'at least one field must be present' });
    }
  });
export type UpdateNavigationMenuRequest = z.infer<typeof UpdateNavigationMenuRequestSchema>;

/** Showing or hiding one menu — the request that can take a whole menu off every public surface at once. */
export const NavigationStateRequestSchema = z.object({ isActive: z.boolean() }).strict();
export type NavigationStateRequest = z.infer<typeof NavigationStateRequestSchema>;

// ---------------------------------------------------------------------------------------------------
// Authoring — items
// ---------------------------------------------------------------------------------------------------
/**
 * Where an entry should point, as a console says it.
 *
 * The union is 0030's CHECK expressed as a shape: a `path` carrying a `pageId`, or a `page` with no id, is
 * refused at the boundary rather than by the database.
 */
export const NavigationTargetInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), pageId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('blog_post'), blogPostId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('category'), categoryId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('path'), path: NavigationPathSchema }).strict(),
]);
export type NavigationTargetInput = z.infer<typeof NavigationTargetInputSchema>;

export const CreateNavigationItemRequestSchema = z
  .object({
    menuId: z.string().uuid(),
    labelEn: LabelSchema,
    labelAr: LabelSchema.nullable().optional(),
    target: NavigationTargetInputSchema,
    /** The heading this entry sits under. 0030 refuses a third level and a parent in another menu. */
    parentId: z.string().uuid().optional(),
    opensInNewTab: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();
export type CreateNavigationItemRequest = z.infer<typeof CreateNavigationItemRequestSchema>;

export const CreateNavigationItemResponseSchema = z.object({ id: z.string().uuid() }).strict();
export type CreateNavigationItemResponse = z.infer<typeof CreateNavigationItemResponseSchema>;

/**
 * Changing an item.
 *
 * `isActive` is absent for the reason it is absent from the menu request. `parentId` can only *set* a parent
 * here: clearing one is its own request, because an absent field has to keep meaning "leave it alone".
 */
export const UpdateNavigationItemRequestSchema = z
  .object({
    labelEn: LabelSchema.optional(),
    labelAr: LabelSchema.nullable().optional(),
    target: NavigationTargetInputSchema.optional(),
    parentId: z.string().uuid().optional(),
    opensInNewTab: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'at least one field must be present' });
    }
  });
export type UpdateNavigationItemRequest = z.infer<typeof UpdateNavigationItemRequestSchema>;

export const ReorderNavigationItemsRequestSchema = z
  .object({
    menuId: z.string().uuid(),
    itemIds: z.array(z.string().uuid()).min(1).max(NAVIGATION_REORDER_MAX),
  })
  .strict();
export type ReorderNavigationItemsRequest = z.infer<typeof ReorderNavigationItemsRequestSchema>;

/** Every write that reports nothing but success. */
export const NavigationWriteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type NavigationWriteResponse = z.infer<typeof NavigationWriteResponseSchema>;
