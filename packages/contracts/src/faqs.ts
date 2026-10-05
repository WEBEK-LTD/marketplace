import { z } from './zod.js';

/**
 * The help centre — what a page shows and how a console authors it (Phase 8, increment 0095).
 *
 * **A topic is free-form, and that is owner decision 5.** 0030's `faqs_topic_format` is the only rule, and no
 * closed list appears anywhere in this file: a topic nobody has mapped to a public address is legal, kept, and
 * reported by the console rather than refused at the boundary.
 *
 * **The mapping is `pages.page_key`, and it is the database's answer** (owner decision 1). Both sides of it live
 * in the database, so `isMapped` and `pageSlug` are read rather than computed here: `/faq` carries
 * `page_key = 'faq'` and `/help` carries `page_key = 'help'`. Nothing in this file decides which address shows
 * what.
 *
 * **An answer is plain text** (owner decision 3). It is a string, it is served as stored, and nothing here marks
 * any part of it as markup — the renderer splits it into paragraphs on blank lines, exactly as a CMS page body is
 * already rendered.
 *
 * **There is no structured data here** (owner decision 4). No schema in this file carries a `FAQPage` document, a
 * JSON-LD field or anything an SEO head would read, and `faqs` is not one of `seo_metadata`'s entity types.
 *
 * **Publishing is never part of a save** (owner decision 6). No authoring request below carries `isPublished`;
 * the state request is its own shape.
 *
 * Every bound is 0030's own where 0030 has one: the topic format and the 300-character question. The answer has
 * no length limit in the schema, so none is invented here beyond the non-empty rule the column already carries.
 */

// ---------------------------------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------------------------------
/** 0030's topic format. A topic is machine identity, like a section key or a menu key. */
export const FAQ_TOPIC_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * A boundary bound on the topic, not the column's.
 *
 * `faqs.topic` is `text` with a format and no length, so this is the request layer refusing something absurd
 * rather than a rule from the schema — which is why it is generous.
 */
export const FAQ_TOPIC_MAX = 60;

/** 0030's own question length, for both languages. */
export const FAQ_QUESTION_MAX = 300;

/** How many entries one reorder may name. A topic nobody can read is not a topic; this is a sanity bound. */
export const FAQ_REORDER_MAX = 200;

export const FAQ_DEFAULT_LIMIT = 25;
export const FAQ_MAX_LIMIT = 100;

export const FaqTopicSchema = z
  .string()
  .trim()
  .min(1)
  .max(FAQ_TOPIC_MAX)
  .regex(FAQ_TOPIC_PATTERN, 'a topic is lowercase letters, digits and underscores');

const QuestionSchema = z.string().trim().min(1).max(FAQ_QUESTION_MAX);
const AnswerSchema = z.string().trim().min(1);

// ---------------------------------------------------------------------------------------------------
// Public — what a page shows
// ---------------------------------------------------------------------------------------------------
/** One published question and its answer, already resolved to the locale that was asked for. */
export const PublicFaqEntrySchema = z
  .object({
    faqId: z.string().uuid(),
    question: z.string().min(1),
    /** Plain text, blank lines and all. The renderer splits paragraphs; nothing treats it as markup. */
    answer: z.string().min(1),
  })
  .strict();
export type PublicFaqEntry = z.infer<typeof PublicFaqEntrySchema>;

/**
 * The entries of one topic.
 *
 * **An empty array is a real answer**, not a 404: a page whose topic has nothing published simply shows no FAQ
 * section (owner decision 2), and the surface needs to be able to tell that from a failure.
 */
export const PublicFaqsResponseSchema = z
  .object({
    topic: FaqTopicSchema,
    entries: z.array(PublicFaqEntrySchema),
  })
  .strict();
export type PublicFaqsResponse = z.infer<typeof PublicFaqsResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------------------------------
export const FaqSummarySchema = z
  .object({
    id: z.string().uuid(),
    topic: FaqTopicSchema,
    questionEn: z.string().min(1),
    questionAr: z.string().nullable(),
    answerEn: z.string().min(1),
    answerAr: z.string().nullable(),
    sortOrder: z.number().int(),
    isPublished: z.boolean(),
    /** Whether a publicly visible page carries this topic as its `page_key` (owner decisions 1 and 5). */
    isMapped: z.boolean(),
    /** The slug of the page that shows it, so a console can check it against the application's own route map. */
    pageSlug: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type FaqSummary = z.infer<typeof FaqSummarySchema>;

export const FaqPageResponseSchema = z
  .object({
    items: z.array(FaqSummarySchema),
    nextCursor: z.string().nullable(),
    /** Whether this caller may change any of it, for the same reason every other console surface reports it. */
    canManage: z.boolean(),
  })
  .strict();
export type FaqPageResponse = z.infer<typeof FaqPageResponseSchema>;

/** One topic in use, with how much of it is published and whether any public address shows it. */
export const FaqTopicSummarySchema = z
  .object({
    topic: FaqTopicSchema,
    entryCount: z.number().int().min(0),
    publishedCount: z.number().int().min(0),
    isMapped: z.boolean(),
    pageSlug: z.string().nullable(),
  })
  .strict();
export type FaqTopicSummary = z.infer<typeof FaqTopicSummarySchema>;

export const FaqTopicsResponseSchema = z
  .object({ topics: z.array(FaqTopicSummarySchema) })
  .strict();
export type FaqTopicsResponse = z.infer<typeof FaqTopicsResponseSchema>;

export const FaqDetailSchema = FaqSummarySchema.extend({ canManage: z.boolean() }).strict();
export type FaqDetail = z.infer<typeof FaqDetailSchema>;

export const FaqDetailResponseSchema = z.object({ faq: FaqDetailSchema }).strict();
export type FaqDetailResponse = z.infer<typeof FaqDetailResponseSchema>;

/**
 * Creating an entry.
 *
 * There is no `isPublished` here, and that is owner decision 6: an entry is created unpublished and publishing is
 * its own request, so a half-written answer cannot reach a public page because one extra field was sent.
 */
export const CreateFaqRequestSchema = z
  .object({
    topic: FaqTopicSchema,
    questionEn: QuestionSchema,
    questionAr: QuestionSchema.nullable().optional(),
    answerEn: AnswerSchema,
    answerAr: AnswerSchema.nullable().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();
export type CreateFaqRequest = z.infer<typeof CreateFaqRequestSchema>;

export const CreateFaqResponseSchema = z.object({ id: z.string().uuid() }).strict();
export type CreateFaqResponse = z.infer<typeof CreateFaqResponseSchema>;

export const UpdateFaqRequestSchema = z
  .object({
    topic: FaqTopicSchema.optional(),
    questionEn: QuestionSchema.optional(),
    questionAr: QuestionSchema.nullable().optional(),
    answerEn: AnswerSchema.optional(),
    answerAr: AnswerSchema.nullable().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'at least one field must be present' });
    }
  });
export type UpdateFaqRequest = z.infer<typeof UpdateFaqRequestSchema>;

/** Publishing or unpublishing one entry — the only request that can put one on a public page. */
export const FaqStateRequestSchema = z.object({ isPublished: z.boolean() }).strict();
export type FaqStateRequest = z.infer<typeof FaqStateRequestSchema>;

export const ReorderFaqsRequestSchema = z
  .object({
    topic: FaqTopicSchema,
    faqIds: z.array(z.string().uuid()).min(1).max(FAQ_REORDER_MAX),
  })
  .strict();
export type ReorderFaqsRequest = z.infer<typeof ReorderFaqsRequestSchema>;

/** Every write that reports nothing but success. */
export const FaqWriteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type FaqWriteResponse = z.infer<typeof FaqWriteResponseSchema>;
