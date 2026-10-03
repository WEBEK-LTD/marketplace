import { describe, expect, it } from 'vitest';
import {
  CreateFaqRequestSchema,
  FAQ_QUESTION_MAX,
  FAQ_REORDER_MAX,
  FAQ_TOPIC_MAX,
  FaqDetailSchema,
  FaqStateRequestSchema,
  FaqTopicsResponseSchema,
  PublicFaqsResponseSchema,
  ReorderFaqsRequestSchema,
  UpdateFaqRequestSchema,
} from '../src/index.js';

/**
 * The help-centre contracts (0095).
 *
 * The things worth proving here, because each one is an owner decision the boundary has to carry:
 *
 *   * **a topic is free-form** within 0030's format, and no closed list exists anywhere (decision 5);
 *   * **publishing is never part of a save** (decision 6);
 *   * **no schema carries structured data, a media reference or anything an SEO head would read** (decision 4);
 *   * **an empty topic is representable**, because a page with nothing published shows no section rather than
 *     failing (decision 2).
 */

const UUID = '11111111-1111-4111-8111-111111111111';

describe('a topic', () => {
  it('accepts any name in 0030s format', () => {
    for (const topic of ['faq', 'help', 'general', 'shipping', 'seller_help', 'a1_b2']) {
      expect(CreateFaqRequestSchema.safeParse({ topic, questionEn: 'Q?', answerEn: 'A.' }).success, topic).toBe(
        true,
      );
    }
  });

  it('refuses a name 0030 would refuse', () => {
    for (const topic of ['FAQ', 'faq-help', '1faq', '_faq', '', ' ', 'x'.repeat(FAQ_TOPIC_MAX + 1)]) {
      expect(
        CreateFaqRequestSchema.safeParse({ topic, questionEn: 'Q?', answerEn: 'A.' }).success,
        JSON.stringify(topic),
      ).toBe(false);
    }
  });
});

describe('creating an entry', () => {
  it('takes both languages, with the Arabic optional', () => {
    const parsed = CreateFaqRequestSchema.parse({
      topic: 'faq',
      questionEn: 'How do I buy?',
      questionAr: 'كيف أشتري؟',
      answerEn: 'Open a listing.',
      answerAr: 'افتح قائمة.',
      sortOrder: 20,
    });
    expect(parsed.questionAr).toBe('كيف أشتري؟');

    expect(
      CreateFaqRequestSchema.safeParse({ topic: 'faq', questionEn: 'Q?', answerEn: 'A.' }).success,
    ).toBe(true);
  });

  it('requires the English question and answer, which is D6', () => {
    expect(CreateFaqRequestSchema.safeParse({ topic: 'faq', answerEn: 'A.' }).success).toBe(false);
    expect(CreateFaqRequestSchema.safeParse({ topic: 'faq', questionEn: 'Q?' }).success).toBe(false);
    expect(
      CreateFaqRequestSchema.safeParse({ topic: 'faq', questionEn: '   ', answerEn: 'A.' }).success,
    ).toBe(false);
    expect(
      CreateFaqRequestSchema.safeParse({ topic: 'faq', questionEn: 'Q?', answerEn: '   ' }).success,
    ).toBe(false);
  });

  it('refuses a question longer than 0030s column', () => {
    expect(
      CreateFaqRequestSchema.safeParse({
        topic: 'faq',
        questionEn: 'x'.repeat(FAQ_QUESTION_MAX + 1),
        answerEn: 'A.',
      }).success,
    ).toBe(false);
  });

  it('accepts an answer of any length, because the column has none', () => {
    expect(
      CreateFaqRequestSchema.safeParse({ topic: 'faq', questionEn: 'Q?', answerEn: 'x'.repeat(20_000) }).success,
    ).toBe(true);
  });

  it('keeps an answers blank lines, which is how paragraphs survive', () => {
    const parsed = CreateFaqRequestSchema.parse({
      topic: 'faq',
      questionEn: 'How do I sell?',
      answerEn: 'Create a profile.\n\nThen list an item.',
    });
    expect(parsed.answerEn).toBe('Create a profile.\n\nThen list an item.');
  });

  it('cannot publish anything (owner decision 6)', () => {
    expect(
      CreateFaqRequestSchema.safeParse({ topic: 'faq', questionEn: 'Q?', answerEn: 'A.', isPublished: true })
        .success,
    ).toBe(false);
    expect(UpdateFaqRequestSchema.safeParse({ questionEn: 'Q?', isPublished: true }).success).toBe(false);
  });

  it('carries nothing an SEO head or a media origin would need (owner decision 4)', () => {
    for (const extra of [
      { structuredData: {} },
      { mediaId: UUID },
      { metaTitle: 'x' },
      { canonicalPath: '/faq' },
    ]) {
      expect(
        CreateFaqRequestSchema.safeParse({ topic: 'faq', questionEn: 'Q?', answerEn: 'A.', ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe('changing an entry', () => {
  it('refuses an update with nothing in it', () => {
    expect(UpdateFaqRequestSchema.safeParse({}).success).toBe(false);
  });

  it('takes one field at a time, and a null Arabic clears it', () => {
    expect(UpdateFaqRequestSchema.parse({ questionAr: null }).questionAr).toBeNull();
    expect(UpdateFaqRequestSchema.parse({ topic: 'help' }).topic).toBe('help');
    expect(UpdateFaqRequestSchema.parse({ sortOrder: 0 }).sortOrder).toBe(0);
  });
});

describe('the state and reorder requests', () => {
  it('take one flag and one order, and nothing else', () => {
    expect(FaqStateRequestSchema.parse({ isPublished: true }).isPublished).toBe(true);
    expect(FaqStateRequestSchema.safeParse({}).success).toBe(false);
    expect(FaqStateRequestSchema.safeParse({ isPublished: true, sortOrder: 1 }).success).toBe(false);

    expect(ReorderFaqsRequestSchema.parse({ topic: 'faq', faqIds: [UUID] }).faqIds).toEqual([UUID]);
    expect(ReorderFaqsRequestSchema.safeParse({ topic: 'faq', faqIds: [] }).success).toBe(false);
    expect(ReorderFaqsRequestSchema.safeParse({ faqIds: [UUID] }).success).toBe(false);
    expect(
      ReorderFaqsRequestSchema.safeParse({ topic: 'faq', faqIds: Array(FAQ_REORDER_MAX + 1).fill(UUID) }).success,
    ).toBe(false);
  });
});

describe('the public response', () => {
  it('carries the words and nothing about the arrangement', () => {
    const parsed = PublicFaqsResponseSchema.parse({
      topic: 'faq',
      entries: [{ faqId: UUID, question: 'How do I buy?', answer: 'Open a listing.\n\nPress buy.' }],
    });
    expect(parsed.entries[0]?.answer).toContain('\n\n');
  });

  it('accepts a topic with nothing published, which renders no section at all', () => {
    expect(PublicFaqsResponseSchema.parse({ topic: 'faq', entries: [] }).entries).toEqual([]);
  });

  it('refuses an entry carrying a publication flag, a position or a topic of its own', () => {
    for (const extra of [{ isPublished: true }, { sortOrder: 10 }, { topic: 'faq' }, { isMapped: true }]) {
      expect(
        PublicFaqsResponseSchema.safeParse({
          topic: 'faq',
          entries: [{ faqId: UUID, question: 'Q?', answer: 'A.', ...extra }],
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe('the console shapes', () => {
  const summary = {
    id: UUID,
    topic: 'faq',
    questionEn: 'How do I buy?',
    questionAr: null,
    answerEn: 'Open a listing.',
    answerAr: null,
    sortOrder: 10,
    isPublished: false,
    isMapped: true,
    pageSlug: 'faq',
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-02T09:00:00.000Z',
  } as const;

  it('report the mapping and the manage capability', () => {
    const parsed = FaqDetailSchema.parse({ ...summary, canManage: true });
    expect(parsed.isMapped).toBe(true);
    expect(parsed.pageSlug).toBe('faq');
    expect(parsed.canManage).toBe(true);
  });

  it('report a topic no public address shows (owner decision 5)', () => {
    const parsed = FaqDetailSchema.parse({
      ...summary,
      topic: 'shipping',
      isMapped: false,
      pageSlug: null,
      canManage: false,
    });
    expect(parsed.isMapped).toBe(false);
    expect(parsed.pageSlug).toBeNull();
  });

  it('summarise every topic in use with both counts', () => {
    const parsed = FaqTopicsResponseSchema.parse({
      topics: [
        { topic: 'faq', entryCount: 3, publishedCount: 2, isMapped: true, pageSlug: 'faq' },
        { topic: 'shipping', entryCount: 1, publishedCount: 0, isMapped: false, pageSlug: null },
      ],
    });
    expect(parsed.topics.map((entry) => entry.publishedCount)).toEqual([2, 0]);
  });
});
