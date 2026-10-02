import { z } from './zod.js';
import {
  ATTRIBUTE_DATA_TYPES,
  AttributeDataTypeSchema,
  AttributeKeySchema,
  AttributeOptionValueSchema,
  TagSlugSchema,
} from './attributes-admin.js';

/**
 * The attributes a seller is asked about one of their own listings, and the tags they may put on it.
 *
 * Both surfaces exist on products and on services, with the same shapes and the same rules: migration 0088's
 * readers and writers take the listing type they are being asked about, so a product slug cannot be answered
 * through the services surface and the reverse.
 *
 * **Which questions exist is the category's answer, not the seller's.** The form is built from what the listing's
 * category asks for, so there is no request here that names an attribute the category did not ask about — one
 * would be refused.
 *
 * **`isRequired` is advisory in this increment** (owner decision). The form marks a required field and says so in
 * words; nothing refuses a save or a submission for want of an answer, and `seller_listing_submit` is untouched.
 * A seller can therefore submit a listing with a required attribute unanswered, and that is the intended
 * behaviour until submission-time enforcement is approved as its own increment.
 *
 * **A save replaces the whole set.** That is how a seller clears an answer: the answer is left out. The same is
 * true of tags. Partial updates would need a per-attribute set-flag, which would make clearing one field and
 * forgetting it the same request.
 */

// ---------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------
/** `listing_attribute_values_text_length`. */
export const LISTING_ATTRIBUTE_TEXT_MAX = 500;

/**
 * `value_number` is an unbounded `numeric`, so this bound is the contract's own and exists only to keep a request
 * from carrying a number no display can render. It is far wider than any physical measurement a listing states.
 */
export const LISTING_ATTRIBUTE_NUMBER_ABS_MAX = 1_000_000_000_000;

/**
 * How many options one multi-select answer may carry, and how many tags one listing may have. Neither has a
 * database limit; both are the contract's own, and exist so that a single request cannot be made arbitrarily
 * large. An attribute's real bound is how many options it has, which the database enforces by refusing an option
 * that is not the attribute's.
 */
export const LISTING_ATTRIBUTE_OPTIONS_MAX = 50;
export const LISTING_TAGS_MAX = 25;

// ---------------------------------------------------------------------------------------------------
// Reading: the questions, with whatever this listing already answers
// ---------------------------------------------------------------------------------------------------
/** One option a seller may choose, in the locale they are working in. */
export const SellerAttributeOptionSchema = z.object({
  value: AttributeOptionValueSchema,
  label: z.string(),
});
export type SellerAttributeOption = z.infer<typeof SellerAttributeOptionSchema>;

/**
 * One question, and this listing's answer to it.
 *
 * The four answer fields are all nullable and exactly one of them is ever set, which is
 * `listing_attribute_values_exactly_one_value` showing through: `options` is an empty array when the attribute is
 * not a select one, or when a select attribute is unanswered.
 *
 * `dataType` is what a form renders the field from. `unit` is only ever present on a number.
 */
export const SellerListingAttributeSchema = z.object({
  key: AttributeKeySchema,
  label: z.string(),
  dataType: AttributeDataTypeSchema,
  unit: z.string().nullable(),
  isRequired: z.boolean(),
  sortOrder: z.number().int(),
  text: z.string().nullable(),
  number: z.number().nullable(),
  boolean: z.boolean().nullable(),
  /** The chosen options, as values. Option identifiers are internal and never leave the API. */
  options: z.array(AttributeOptionValueSchema),
  /** Everything this attribute offers, empty unless it is a select one. */
  choices: z.array(SellerAttributeOptionSchema),
});
export type SellerListingAttribute = z.infer<typeof SellerListingAttributeSchema>;

export const SellerListingAttributesResponseSchema = z.object({
  attributes: z.array(SellerListingAttributeSchema),
  /** False once the listing is no longer a draft: 0061's rule, reported rather than restated by a screen. */
  isEditable: z.boolean(),
});
export type SellerListingAttributesResponse = z.infer<typeof SellerListingAttributesResponseSchema>;

/** One tag a seller may choose, and whether this listing carries it. */
export const SellerListingTagChoiceSchema = z.object({
  slug: TagSlugSchema,
  name: z.string(),
  isSelected: z.boolean(),
});
export type SellerListingTagChoice = z.infer<typeof SellerListingTagChoiceSchema>;

export const SellerListingTagsResponseSchema = z.object({
  tags: z.array(SellerListingTagChoiceSchema),
  isEditable: z.boolean(),
});
export type SellerListingTagsResponse = z.infer<typeof SellerListingTagsResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Writing: one answer per attribute, discriminated by what the attribute is
// ---------------------------------------------------------------------------------------------------
/**
 * One answer, shaped by the attribute's own data type.
 *
 * A discriminated union rather than one object with four optional fields, because the four fields are mutually
 * exclusive in the database — `listing_attribute_values_exactly_one_value` — and a shape that could express a
 * number *and* a boolean would be a shape the database refuses. `.strict()` on each member means an answer that
 * carries the wrong field for its kind is a validation failure here rather than a refusal later.
 *
 * `kind` must match the attribute's stored `data_type`; the database is the judge of that, and an answer whose
 * kind disagrees with its attribute is refused by 0011's trigger exactly as a bare mismatched value would be.
 *
 * `single_select` takes exactly one option and `multi_select` at least one. An attribute a seller wants to leave
 * unanswered is left out of the request altogether, which is what clears it.
 */
export const SellerAttributeAnswerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      key: AttributeKeySchema,
      text: z
        .string()
        .min(1)
        .max(LISTING_ATTRIBUTE_TEXT_MAX)
        .refine((value) => value.trim() !== '', { message: 'an answer cannot be blank' }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('number'),
      key: AttributeKeySchema,
      number: z
        .number()
        .finite()
        .min(-LISTING_ATTRIBUTE_NUMBER_ABS_MAX)
        .max(LISTING_ATTRIBUTE_NUMBER_ABS_MAX),
    })
    .strict(),
  z.object({ kind: z.literal('boolean'), key: AttributeKeySchema, boolean: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('single_select'),
      key: AttributeKeySchema,
      options: z.array(AttributeOptionValueSchema).length(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('multi_select'),
      key: AttributeKeySchema,
      options: z.array(AttributeOptionValueSchema).min(1).max(LISTING_ATTRIBUTE_OPTIONS_MAX),
    })
    .strict(),
]);
export type SellerAttributeAnswer = z.infer<typeof SellerAttributeAnswerSchema>;

/** The five kinds an answer can take, which are the five an attribute can be. */
export const SELLER_ATTRIBUTE_ANSWER_KINDS = ATTRIBUTE_DATA_TYPES;

/**
 * Replace every answer on one listing.
 *
 * One attribute may be answered once: a second answer for the same key would make the request's meaning depend on
 * the order of an array, so it is refused here rather than resolved by whichever came last.
 */
export const SaveSellerListingAttributesRequestSchema = z
  .object({
    answers: z
      .array(SellerAttributeAnswerSchema)
      .max(LISTING_ATTRIBUTE_OPTIONS_MAX)
      .refine((answers) => new Set(answers.map((answer) => answer.key)).size === answers.length, {
        message: 'each attribute may be answered once',
      }),
  })
  .strict();
export type SaveSellerListingAttributesRequest = z.infer<typeof SaveSellerListingAttributesRequestSchema>;

/** Replace every tag on one listing, by slug. An empty array removes them all. */
export const SaveSellerListingTagsRequestSchema = z
  .object({
    tags: z
      .array(TagSlugSchema)
      .max(LISTING_TAGS_MAX)
      .refine((tags) => new Set(tags).size === tags.length, { message: 'each tag may be chosen once' }),
  })
  .strict();
export type SaveSellerListingTagsRequest = z.infer<typeof SaveSellerListingTagsRequestSchema>;

/** Both writes answer the same way: the listing they wrote to, and what it holds now. */
export const SellerListingAttributesWriteResponseSchema = z.object({
  slug: z.string(),
  saved: z.literal(true),
});
export type SellerListingAttributesWriteResponse = z.infer<typeof SellerListingAttributesWriteResponseSchema>;
