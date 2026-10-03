import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  FAQ_DEFAULT_LIMIT,
  FAQ_MAX_LIMIT,
  type FaqDetail,
  type FaqPageResponse,
  type FaqSummary,
  type FaqTopicsResponse,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import { decodeFaqCursor, encodeFaqCursor } from './faqs.cursor.js';
import type { FaqRefusalCode } from './faqs.errors.js';
import {
  FaqCursorInvalidError,
  FaqNotFoundError,
  FaqRefusedError,
  FaqUnavailableError,
} from './faqs.errors.js';

/**
 * Authoring the help centre (0095).
 *
 * **Authorization, in the one order it is ever done**, which is this console's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token.
 *   3. The **database** reports the caller's *effective* permissions under the platform's own `requires_mfa` rule.
 *      Both roles that hold an FAQ key require MFA, so staff at `aal1` hold nothing at all.
 *   4. Every `app_private` function below **re-applies the same test itself**, with the account and the assurance
 *      level as parameters and the key as a **literal**. No bug in this file can turn into somebody publishing an
 *      answer on the site's help page.
 *
 * **Two keys, and the separation is visible to the console.** `cms.faq.read` opens the section and every read;
 * `cms.faq.manage` is required by every write, and both the list and the detail report whether this caller holds
 * it, so a console renders its controls from the answer rather than from a role name.
 *
 * **Every rule this surface appears to apply is applied in the database.** The topic format, the question lengths
 * and that an answer is not empty are 0030's constraints; whether a public page shows a topic is `pages.page_key`,
 * answered by the reader. This service passes the caller's account and shapes the answer.
 *
 * **One page is one read.** The cursor is decoded here and the position is passed as three typed parameters, never
 * interpolated.
 */

export const FAQ_READ = 'cms.faq.read';
export const FAQ_MANAGE = 'cms.faq.manage';

export const FAQS_STORE = Symbol('FAQS_STORE');

/** One row of `app_private.faqs_for_staff` (0095). */
export interface FaqListDbRow {
  readonly faqId: string;
  readonly topic: string;
  readonly questionEn: string;
  readonly questionAr: string | null;
  readonly answerEn: string;
  readonly answerAr: string | null;
  readonly sortOrder: number | string;
  readonly isPublished: boolean;
  readonly isMapped: boolean;
  readonly pageSlug: string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

/** One row of `app_private.faq_for_staff` (0095). */
export interface FaqDetailDbRow extends FaqListDbRow {
  readonly canManage: boolean;
}

/** One row of `app_private.faq_topics_for_staff` (0095). */
export interface FaqTopicDbRow {
  readonly topic: string;
  readonly entryCount: number | string;
  readonly publishedCount: number | string;
  readonly isMapped: boolean;
  readonly pageSlug: string | null;
}

export interface FaqsStore {
  faqTopicsForStaff(input: { userId: string; isAal2: boolean }): Promise<readonly FaqTopicDbRow[]>;

  faqsForStaff(input: {
    userId: string;
    isAal2: boolean;
    topic: string | null;
    afterTopic: string | null;
    afterSortOrder: number | null;
    afterId: string | null;
    limit: number;
  }): Promise<readonly FaqListDbRow[]>;

  faqForStaff(input: { userId: string; isAal2: boolean; faqId: string }): Promise<FaqDetailDbRow | null>;

  faqSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    faqId: string | null;
    topic: string | null;
    questionEn: string | null;
    questionAr: string | null;
    answerEn: string | null;
    answerAr: string | null;
    sortOrder: number | null;
  }): Promise<string | null>;

  faqStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    faqId: string;
    isPublished: boolean;
  }): Promise<boolean>;

  faqsReorderForStaff(input: {
    userId: string;
    isAal2: boolean;
    topic: string;
    faqIds: readonly string[];
  }): Promise<number>;

  faqDeleteForStaff(input: { userId: string; isAal2: boolean; faqId: string }): Promise<boolean>;
}

/**
 * The SQLSTATEs a refused write arrives as, each with **our own** code and sentence.
 *
 * The database's text is deliberately not forwarded: a PostgreSQL constraint message is a different kind of value
 * from an API response, and mapping the five characters to a code we control means a change to a constraint's
 * wording cannot change what a browser is shown.
 */
const REFUSALS: ReadonlyMap<string, { readonly code: FaqRefusalCode; readonly detail: string }> = new Map([
  [
    '23514',
    {
      code: 'FAQ_NOT_ALLOWED' as const,
      detail: 'That is not an allowed value for a help-centre entry.',
    },
  ],
  [
    '23502',
    {
      code: 'FAQ_NOT_ALLOWED' as const,
      detail: 'That is not an allowed value for a help-centre entry.',
    },
  ],
]);

function sqlstateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function toSummary(row: FaqListDbRow): FaqSummary {
  return {
    id: row.faqId,
    topic: row.topic,
    questionEn: row.questionEn,
    questionAr: row.questionAr,
    answerEn: row.answerEn,
    answerAr: row.answerAr,
    sortOrder: toNumber(row.sortOrder),
    isPublished: row.isPublished,
    isMapped: row.isMapped,
    pageSlug: row.pageSlug,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

@Injectable()
export class FaqsAdminService {
  private readonly logger = new Logger(FaqsAdminService.name);

  constructor(
    @Inject(FAQS_STORE) private readonly store: FaqsStore,
    private readonly console: StaffConsoleService,
  ) {}

  /** Every topic in use, mapped ones first. */
  async topics(input: { accessToken: string }): Promise<FaqTopicsResponse> {
    const staff = await this.#reader(input.accessToken);

    let rows: readonly FaqTopicDbRow[];
    try {
      rows = await this.store.faqTopicsForStaff({ userId: staff.id, isAal2: staff.isAal2 });
    } catch (error) {
      this.logger.error('The help-centre topics could not be read.');
      throw new FaqUnavailableError(error);
    }

    return {
      topics: rows.map((row) => ({
        topic: row.topic,
        entryCount: toNumber(row.entryCount),
        publishedCount: toNumber(row.publishedCount),
        isMapped: row.isMapped,
        pageSlug: row.pageSlug,
      })),
    };
  }

  /** One page of entries, in help-centre order, with whether this caller may change any of it. */
  async list(input: {
    accessToken: string;
    topic: string | null;
    cursor: string | null;
    limit: number | null;
  }): Promise<FaqPageResponse> {
    const staff = await this.#reader(input.accessToken);

    const position = input.cursor === null ? null : decodeFaqCursor(input.cursor);
    // A cursor that is not a position is the client's mistake, and saying so is more useful than silently
    // serving the first page as if nothing had been asked for.
    if (input.cursor !== null && position === null) throw new FaqCursorInvalidError();

    const limit = Math.min(Math.max(input.limit ?? FAQ_DEFAULT_LIMIT, 1), FAQ_MAX_LIMIT);

    let rows: readonly FaqListDbRow[];
    try {
      // One more than asked for, so the presence of a next page is observed rather than guessed.
      rows = await this.store.faqsForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        topic: input.topic,
        afterTopic: position?.topic ?? null,
        afterSortOrder: position?.sortOrder ?? null,
        afterId: position?.id ?? null,
        limit: limit + 1,
      });
    } catch (error) {
      this.logger.error('The help-centre entries could not be read.');
      throw new FaqUnavailableError(error);
    }

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const session = await this.console.forToken(input.accessToken);

    return {
      items: page.map(toSummary),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeFaqCursor({ topic: last.topic, sortOrder: toNumber(last.sortOrder), id: last.faqId })
          : null,
      canManage: session.permissions.includes(FAQ_MANAGE),
    };
  }

  /** One entry. */
  async detail(input: { accessToken: string; faqId: string }): Promise<FaqDetail> {
    const staff = await this.#reader(input.accessToken);

    let row: FaqDetailDbRow | null;
    try {
      row = await this.store.faqForStaff({ userId: staff.id, isAal2: staff.isAal2, faqId: input.faqId });
    } catch (error) {
      this.logger.error('The help-centre entry could not be read.');
      throw new FaqUnavailableError(error);
    }

    // No row covers both an entry that does not exist and a caller without the read key.
    if (row === null) throw new FaqNotFoundError();

    return { ...toSummary(row), canManage: row.canManage };
  }

  /** Creates an unpublished entry. */
  async create(input: {
    accessToken: string;
    topic: string;
    questionEn: string;
    questionAr: string | null;
    answerEn: string;
    answerAr: string | null;
    sortOrder: number | null;
  }): Promise<string> {
    const staff = await this.#reader(input.accessToken);
    const id = await this.#write(async () =>
      this.store.faqSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        faqId: null,
        topic: input.topic,
        questionEn: input.questionEn,
        questionAr: input.questionAr,
        answerEn: input.answerEn,
        answerAr: input.answerAr,
        sortOrder: input.sortOrder,
      }),
    );
    if (id === null) throw new FaqUnavailableError();
    return id;
  }

  /** Changes an entry. Never whether it is published: that is the next call. */
  async update(input: {
    accessToken: string;
    faqId: string;
    topic: string | null;
    questionEn: string | null;
    questionAr: string | null;
    answerEn: string | null;
    answerAr: string | null;
    sortOrder: number | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const id = await this.#write(async () =>
      this.store.faqSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        faqId: input.faqId,
        topic: input.topic,
        questionEn: input.questionEn,
        questionAr: input.questionAr,
        answerEn: input.answerEn,
        answerAr: input.answerAr,
        sortOrder: input.sortOrder,
      }),
    );
    // Null means the identifier named nothing. The writer does not create one in that case.
    if (id === null) throw new FaqNotFoundError();
  }

  /** Publishes or unpublishes one entry — the only call that can put one on a public page. */
  async setState(input: { accessToken: string; faqId: string; isPublished: boolean }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.faqStateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        faqId: input.faqId,
        isPublished: input.isPublished,
      }),
    );
    if (!changed) throw new FaqNotFoundError();
  }

  /** Sets the order of the entries named, inside one topic. */
  async reorder(input: { accessToken: string; topic: string; faqIds: readonly string[] }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    await this.#write(async () =>
      this.store.faqsReorderForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        topic: input.topic,
        faqIds: input.faqIds,
      }),
    );
    // Deliberately not an error when nothing moved: an order that named only entries somebody else has since
    // deleted is a stale screen, and the remedy is to reload — not a refusal the console has to explain.
  }

  /** Removes one entry. */
  async remove(input: { accessToken: string; faqId: string }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const deleted = await this.#write(async () =>
      this.store.faqDeleteForStaff({ userId: staff.id, isAal2: staff.isAal2, faqId: input.faqId }),
    );
    if (!deleted) throw new FaqNotFoundError();
  }

  /**
   * Runs a write and sorts its failures.
   *
   * `42501` is the database refusing a caller who does not hold `cms.faq.manage`. It becomes a 404 rather than a
   * 403: a caller may hold the read key and not the manage key, and the list already reports which through
   * `canManage`. Turning it into an absence keeps this surface's one rule — a refusal and an absence look alike.
   */
  async #write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '42501') throw new FaqNotFoundError();
      const refusal = sqlstate === null ? undefined : REFUSALS.get(sqlstate);
      if (refusal !== undefined) throw new FaqRefusedError(refusal.code, refusal.detail);
      this.logger.error('A help-centre entry could not be written.');
      throw new FaqUnavailableError(error);
    }
  }

  async #reader(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(FAQ_READ)) throw new FaqNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }
}
