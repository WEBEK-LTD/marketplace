import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PublicFaqEntry, PublicLocale } from '@repo/contracts';
import { CmsPublicUnavailableError } from './cms-errors.js';

/**
 * The public side of the help centre (0095).
 *
 * **This service reads; it decides nothing.** Which entries are published is the database's answer, the order is
 * the operator's, and which address shows which topic is owner decision 1 — carried out by the page that asks,
 * because a page's `page_key` *is* the topic and only the page knows its own key.
 *
 * **An empty answer is a real answer** (owner decision 2). A topic nobody has published anything under returns no
 * entries, the page renders no section, and nothing here treats that as a failure.
 *
 * **An answer is plain text** (owner decision 3). It is carried through exactly as stored, blank lines included,
 * so the renderer can split paragraphs; nothing here marks any part of it as markup.
 *
 * **Nothing here reads a promotion, a banner, a media row or `seo_metadata`.** A question is words.
 */

export const FAQS_PUBLIC_STORE = Symbol('FAQS_PUBLIC_STORE');

/** One row of `app_private.public_faqs` (0095). */
export interface PublicFaqDbRow {
  readonly faqId: string;
  readonly question: string;
  readonly answer: string;
  readonly sortOrder: number | string;
}

export interface FaqsPublicStore {
  /** `app_private.public_faqs(text, text)`: the published entries of one topic, in the operator's order. */
  publicFaqs(input: { topic: string; locale: PublicLocale }): Promise<readonly PublicFaqDbRow[]>;
}

@Injectable()
export class FaqsPublicService {
  private readonly logger = new Logger(FaqsPublicService.name);

  constructor(@Inject(FAQS_PUBLIC_STORE) private readonly store: FaqsPublicStore) {}

  /**
   * The published entries of one topic.
   *
   * A database that cannot answer is a 503 and never an empty help centre: a page that showed no questions when
   * the truth is that we could not read them would be a wrong answer rather than an honest failure, and the web
   * layer renders the page itself either way.
   */
  async entries(input: { topic: string; locale: PublicLocale }): Promise<readonly PublicFaqEntry[]> {
    let rows: readonly PublicFaqDbRow[];
    try {
      rows = await this.store.publicFaqs(input);
    } catch (error) {
      this.logger.error('The help-centre entries could not be read.');
      throw new CmsPublicUnavailableError(error);
    }

    return rows.map((row) => ({ faqId: row.faqId, question: row.question, answer: row.answer }));
  }
}
