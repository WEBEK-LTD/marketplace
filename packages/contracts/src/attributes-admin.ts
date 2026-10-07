import { z } from './zod.js';

/**
 * The structured attribute vocabulary and the tag vocabulary, as the admin console works with them.
 *
 * `attribute_definitions`, `attribute_options`, `tags` and `category_attributes` have existed since migrations
 * 0010 and 0011, with public readers over them and no way to write one. This is that surface. Every limit below
 * is read off a constraint that already exists; where a column carries no constraint, the bound is marked as the
 * contract's own and exists only to keep a request from being unbounded.
 *
 * Three things are deliberately unexpressible.
 *
 * **A definition's `key` and `data_type` cannot be changed.** The key is the identity a public listing projection
 * carries and the data type is what every answer already stored was validated against, so changing either would
 * silently reinterpret live data. Neither appears in the update request.
 *
 * **An option's `value` and a tag's `slug` cannot be changed**, for the same reason: both are machine identity.
 * Labels and names are what an administrator edits.
 *
 * **Nothing here deletes anything.** `category_attributes` holds an `on delete restrict` foreign key to
 * definitions, and tags are referenced by listings, so the operation that exists is hiding: `isActive` is its own
 * request on every one of the three vocabularies, and the public readers of 0047 already filter on it.
 *
 * **`isFilterable` is stored and reported, and nothing filters by it.** Attribute filtering and search facets are
 * out of scope for this increment (owner decision), so the flag is recorded for a later one and the console shows
 * it as the statement of intent it is.
 */

// ---------------------------------------------------------------------------------------------------
// Limits, each one read off a constraint in migration 0010 unless marked otherwise
// ---------------------------------------------------------------------------------------------------
/** `attribute_definitions_key_format`. A lowercase identifier: the public contract's name for the attribute. */
export const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** `attribute_options_value_format`. */
export const ATTRIBUTE_OPTION_VALUE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** `tags_slug_format`: a slug of 1–50 characters. */
export const TAG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

/**
 * `attribute_definitions_key_format` and `attribute_options_value_format` bound the shape of a key and a value
 * but not their length, so these two bounds are the contract's own. They are generous: a key is written once and
 * read forever, and a tighter limit would be inventing an editorial rule nobody wrote.
 */
export const ATTRIBUTE_KEY_MAX = 60;
export const ATTRIBUTE_OPTION_VALUE_MAX = 60;

/**
 * `attribute_definitions_names_present`, `attribute_options_labels_present` and `tags_names_present` require a
 * non-blank name and say nothing about length, so this bound is the contract's own and matches the one 0010 puts
 * on a category name, which is the field it sits beside in a console.
 */
export const ATTRIBUTE_LABEL_MAX = 120;

/** `attribute_definitions_unit_only_for_number` governs whether a unit may exist; its length is ours. */
export const ATTRIBUTE_UNIT_MAX = 16;

/** `attribute_definitions_data_type_allowed`: the five kinds of answer an attribute can take. */
export const ATTRIBUTE_DATA_TYPES = ['text', 'number', 'boolean', 'single_select', 'multi_select'] as const;
export type AttributeDataType = (typeof ATTRIBUTE_DATA_TYPES)[number];
export const AttributeDataTypeSchema = z.enum(ATTRIBUTE_DATA_TYPES);

/** The two kinds that have options. A unit belongs to `number` and to nothing else. */
export const ATTRIBUTE_SELECT_TYPES = ['single_select', 'multi_select'] as const satisfies readonly AttributeDataType[];
export function attributeHasOptions(dataType: AttributeDataType): boolean {
  return (ATTRIBUTE_SELECT_TYPES as readonly string[]).includes(dataType);
}

/** `sort_order` is an integer column; these bounds keep a request inside one. */
export const ATTRIBUTE_SORT_ORDER_MIN = 0;
export const ATTRIBUTE_SORT_ORDER_MAX = 2_147_483_647;

const SortOrderSchema = z.number().int().min(ATTRIBUTE_SORT_ORDER_MIN).max(ATTRIBUTE_SORT_ORDER_MAX);

export const AttributeKeySchema = z.string().min(1).max(ATTRIBUTE_KEY_MAX).regex(ATTRIBUTE_KEY_PATTERN);
export const AttributeOptionValueSchema = z
  .string()
  .min(1)
  .max(ATTRIBUTE_OPTION_VALUE_MAX)
  .regex(ATTRIBUTE_OPTION_VALUE_PATTERN);
export const TagSlugSchema = z.string().min(1).regex(TAG_SLUG_PATTERN);

/** A label must survive `btrim` with something left, which is what the three `_present` constraints say. */
const LabelSchema = z.string().min(1).max(ATTRIBUTE_LABEL_MAX).refine((value) => value.trim() !== '', {
  message: 'a label cannot be blank',
});

// ---------------------------------------------------------------------------------------------------
// Reading the attribute vocabulary
// ---------------------------------------------------------------------------------------------------
/**
 * One attribute definition as the console lists it.
 *
 * The three counts travel with the row because each one decides whether an edit is safe to offer: `optionCount`
 * is why a select attribute can or cannot be shown, `categoryCount` says how many categories would change if it
 * were hidden, and `answerCount` says how many sellers have already answered it.
 */
export const AdminAttributeDefinitionSchema = z.object({
  definitionId: z.string().uuid(),
  key: AttributeKeySchema,
  dataType: AttributeDataTypeSchema,
  unit: z.string().nullable(),
  nameEn: z.string(),
  nameAr: z.string(),
  isFilterable: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  optionCount: z.number().int().min(0),
  categoryCount: z.number().int().min(0),
  answerCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AdminAttributeDefinition = z.infer<typeof AdminAttributeDefinitionSchema>;

export const AdminAttributeDefinitionsResponseSchema = z.object({
  attributes: z.array(AdminAttributeDefinitionSchema),
  /** The server's answer about the caller, which is what a console renders its controls from. */
  canManage: z.boolean(),
});
export type AdminAttributeDefinitionsResponse = z.infer<typeof AdminAttributeDefinitionsResponseSchema>;

/** One option of one select attribute. `answerCount` is how many listings have chosen it. */
export const AdminAttributeOptionSchema = z.object({
  optionId: z.string().uuid(),
  value: AttributeOptionValueSchema,
  labelEn: z.string(),
  labelAr: z.string(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  answerCount: z.number().int().min(0),
});
export type AdminAttributeOption = z.infer<typeof AdminAttributeOptionSchema>;

export const AdminAttributeDetailResponseSchema = z.object({
  attribute: AdminAttributeDefinitionSchema,
  /** Empty for a text, number or boolean attribute, which has no options and can take none. */
  options: z.array(AdminAttributeOptionSchema),
  canManage: z.boolean(),
});
export type AdminAttributeDetailResponse = z.infer<typeof AdminAttributeDetailResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Writing the attribute vocabulary
// ---------------------------------------------------------------------------------------------------
/**
 * Create one attribute definition.
 *
 * The key and the data type are given here and never again. There is no `isActive`: a new definition is always
 * hidden, because a select attribute with no options yet would otherwise appear on sellers' forms as a field
 * nobody can answer.
 */
export const CreateAttributeDefinitionRequestSchema = z
  .object({
    key: AttributeKeySchema,
    dataType: AttributeDataTypeSchema,
    nameEn: LabelSchema,
    nameAr: LabelSchema,
    // 0105. Trimmed, so a unit of one tab is refused here rather than stored as whitespace.
    unit: z.string().trim().min(1).max(ATTRIBUTE_UNIT_MAX).optional(),
    isFilterable: z.boolean().optional(),
    sortOrder: SortOrderSchema.optional(),
  })
  .strict()
  .refine((value) => value.unit === undefined || value.dataType === 'number', {
    message: 'only a number attribute has a unit',
    path: ['unit'],
  });
export type CreateAttributeDefinitionRequest = z.infer<typeof CreateAttributeDefinitionRequestSchema>;

export const CreateAttributeDefinitionResponseSchema = z.object({ definitionId: z.string().uuid() });
export type CreateAttributeDefinitionResponse = z.infer<typeof CreateAttributeDefinitionResponseSchema>;

/**
 * Edit what an attribute is called, what it is measured in, whether it is meant to be filterable and where it
 * appears in a list. `key` and `dataType` are absent, and `.strict()` makes sending either a validation failure
 * rather than a value quietly dropped.
 *
 * A unit on an attribute that is not a number cannot be caught here, because the request does not carry the data
 * type and would have to be believed about it. `attribute_definitions_unit_only_for_number` catches it, and the
 * answer is a refusal rather than a 400 — the request was well formed and the attribute is what refused it.
 */
export const UpdateAttributeDefinitionRequestSchema = z
  .object({
    nameEn: LabelSchema,
    nameAr: LabelSchema,
    /** An empty string clears the unit; a unit left out clears it too, because this request replaces the row. */
    unit: z.string().max(ATTRIBUTE_UNIT_MAX).optional(),
    isFilterable: z.boolean(),
    sortOrder: SortOrderSchema,
  })
  .strict();
export type UpdateAttributeDefinitionRequest = z.infer<typeof UpdateAttributeDefinitionRequestSchema>;

/**
 * Show or hide one attribute definition, one option or one tag.
 *
 * Its own request on all three, because hiding is the only operation a visitor sees and it should never happen as
 * a side effect of renaming something.
 */
export const VocabularyStateRequestSchema = z.object({ isActive: z.boolean() }).strict();
export type VocabularyStateRequest = z.infer<typeof VocabularyStateRequestSchema>;

/** Add one option to a select attribute. Created active: an option exists in order to be chosen. */
export const CreateAttributeOptionRequestSchema = z
  .object({
    value: AttributeOptionValueSchema,
    labelEn: LabelSchema,
    labelAr: LabelSchema,
    sortOrder: SortOrderSchema.optional(),
  })
  .strict();
export type CreateAttributeOptionRequest = z.infer<typeof CreateAttributeOptionRequestSchema>;

export const CreateAttributeOptionResponseSchema = z.object({ optionId: z.string().uuid() });
export type CreateAttributeOptionResponse = z.infer<typeof CreateAttributeOptionResponseSchema>;

/** Edit one option's labels and position. `value` is absent: it is the identity stored in every answer. */
export const UpdateAttributeOptionRequestSchema = z
  .object({ labelEn: LabelSchema, labelAr: LabelSchema, sortOrder: SortOrderSchema })
  .strict();
export type UpdateAttributeOptionRequest = z.infer<typeof UpdateAttributeOptionRequestSchema>;

// ---------------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------------
/** One tag. `usageCount` is 0011's trigger's number, not a count this surface takes. */
export const AdminTagSchema = z.object({
  tagId: z.string().uuid(),
  slug: TagSlugSchema,
  nameEn: z.string(),
  nameAr: z.string(),
  isActive: z.boolean(),
  usageCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AdminTag = z.infer<typeof AdminTagSchema>;

export const AdminTagsResponseSchema = z.object({
  tags: z.array(AdminTagSchema),
  canManage: z.boolean(),
});
export type AdminTagsResponse = z.infer<typeof AdminTagsResponseSchema>;

/** Create one tag, active: unlike a select attribute there is nothing to fill in first. */
export const CreateTagRequestSchema = z
  .object({ slug: TagSlugSchema, nameEn: LabelSchema, nameAr: LabelSchema })
  .strict();
export type CreateTagRequest = z.infer<typeof CreateTagRequestSchema>;

export const CreateTagResponseSchema = z.object({ tagId: z.string().uuid() });
export type CreateTagResponse = z.infer<typeof CreateTagResponseSchema>;

/** Rename one tag. `slug` is absent: it is the tag's public identity. */
export const UpdateTagRequestSchema = z.object({ nameEn: LabelSchema, nameAr: LabelSchema }).strict();
export type UpdateTagRequest = z.infer<typeof UpdateTagRequestSchema>;

// ---------------------------------------------------------------------------------------------------
// Which attributes a category asks for
// ---------------------------------------------------------------------------------------------------
/**
 * One attribute a category asks its sellers about.
 *
 * `isRequired` is **advisory in this increment** (owner decision): a seller's form marks the field as required
 * and says so, and no writer refuses a listing for want of an answer. `seller_listing_submit` is untouched.
 */
export const AdminCategoryAttributeSchema = z.object({
  definitionId: z.string().uuid(),
  key: AttributeKeySchema,
  dataType: AttributeDataTypeSchema,
  unit: z.string().nullable(),
  nameEn: z.string(),
  nameAr: z.string(),
  isRequired: z.boolean(),
  isFilterable: z.boolean(),
  sortOrder: z.number().int(),
  /** The definition's own state. An attached attribute that is hidden is asked of nobody. */
  isActive: z.boolean(),
  optionCount: z.number().int().min(0),
});
export type AdminCategoryAttribute = z.infer<typeof AdminCategoryAttributeSchema>;

export const AdminCategoryAttributesResponseSchema = z.object({
  attributes: z.array(AdminCategoryAttributeSchema),
  /** `catalog.category.manage`, which is what `category_attributes`' own write policy names — not the attribute key. */
  canManage: z.boolean(),
});
export type AdminCategoryAttributesResponse = z.infer<typeof AdminCategoryAttributesResponseSchema>;

/**
 * Ask a category for one attribute, or change how it asks.
 *
 * One request for both, because attaching something already attached is an edit of how it is asked rather than an
 * error: a console that had to know which it was would have to ask first and could still be wrong by the time it
 * wrote.
 */
export const AttachCategoryAttributeRequestSchema = z
  .object({
    definitionId: z.string().uuid(),
    isRequired: z.boolean().optional(),
    isFilterable: z.boolean().optional(),
    sortOrder: SortOrderSchema.optional(),
  })
  .strict();
export type AttachCategoryAttributeRequest = z.infer<typeof AttachCategoryAttributeRequestSchema>;

/** Every write on these surfaces answers the same way: whether it changed anything. */
export const VocabularyWriteResponseSchema = z.object({ changed: z.boolean() });
export type VocabularyWriteResponse = z.infer<typeof VocabularyWriteResponseSchema>;
