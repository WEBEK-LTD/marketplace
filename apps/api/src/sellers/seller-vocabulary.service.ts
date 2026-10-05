import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ATTRIBUTE_DATA_TYPES,
  type AttributeDataType,
  type SaveSellerListingAttributesRequest,
  type SellerAttributeOption,
  type SellerListingAttribute,
  type SellerListingTagChoice,
} from '@repo/contracts';
import {
  SellerIdentityUnavailableError,
  SellerListingNotEditableError,
  SellerListingNotFoundError,
} from './seller-errors.js';
import { SellerVocabularyAnswerRefusedError } from './seller-vocabulary.errors.js';

/**
 * The attributes a seller is asked about one of their own listings, and the tags they may put on it (Phase 8-C).
 *
 * Every rule lives in migrations 0010, 0011 and 0088, and this layer turns outcome strings into the approved
 * errors. There is no second ownership check, no second type check and no second state machine here — which is
 * what keeps two copies of a rule from drifting, and why no refusal can be produced here that the database would
 * have allowed, or the reverse.
 *
 * **The caller names no owner.** `userId` is the account the API resolved from the caller's own access token; it
 * is never read from a body, a query string or a path. The surface — product or service — is named by the route
 * rather than the request, so a product slug reached through the services surface is reported absent exactly as a
 * slug that names nothing.
 *
 * **`is_required` is advisory in this increment** (owner decision). This service reports which attributes are
 * marked required so a form can mark them, and refuses nothing for want of an answer. `seller_listing_submit` is
 * not called from here, not imported here and not modified by this increment, so a listing with an unanswered
 * required attribute submits exactly as it did before.
 *
 * **Option identifiers never leave the API.** The database answers with the ids a listing has chosen and, through
 * a second reader, every option each attribute offers; this service joins the two so the contract carries values.
 * An id in a browser would be a second identity for the same option, and the value is the one that is stable.
 */

export const SELLER_VOCABULARY_STORE = Symbol('SELLER_VOCABULARY_STORE');

/** Which surface a route addresses. Named by the route, never by the request. */
export type SellerVocabularySurface = 'product' | 'service';

export interface SellerVocabularyContextRow {
  readonly outcome: string;
  readonly isEditable: boolean;
}

export interface SellerListingAttributeRow {
  readonly definitionId: string;
  readonly key: string;
  readonly dataType: string;
  readonly unit: string | null;
  readonly label: string;
  readonly isRequired: boolean;
  readonly sortOrder: number;
  readonly valueText: string | null;
  readonly valueNumber: number | null;
  readonly valueBoolean: boolean | null;
  readonly optionIds: readonly string[];
}

export interface SellerListingAttributeOptionRow {
  readonly definitionId: string;
  readonly optionId: string;
  readonly value: string;
  readonly label: string;
  readonly sortOrder: number;
}

export interface SellerListingTagChoiceRow {
  readonly slug: string;
  readonly label: string;
  readonly isSelected: boolean;
}

/** Both writers answer in 0088's vocabulary: `saved`, `not_found`, `not_editable` or `invalid`. */
export interface SellerVocabularyWriteResult {
  readonly outcome: string;
}

/** One answer, in the shape the database's jsonb payload takes. Built here from the validated request. */
export interface SellerAttributeAnswerPayload {
  readonly key: string;
  readonly text?: string;
  readonly number?: number;
  readonly boolean?: boolean;
  readonly options?: readonly string[];
}

export interface SellerVocabularyStore {
  /** `app_private.seller_listing_vocabulary_context(...)` (0088). */
  sellerListingVocabularyContext(input: {
    userId: string;
    slug: string;
    expectedType: string;
  }): Promise<SellerVocabularyContextRow>;
  /** `app_private.seller_listing_attributes(...)` (0088). */
  sellerListingAttributes(input: {
    userId: string;
    slug: string;
    expectedType: string;
    locale: string;
  }): Promise<readonly SellerListingAttributeRow[]>;
  /** `app_private.seller_listing_attribute_options(...)` (0088). */
  sellerListingAttributeOptions(input: {
    userId: string;
    slug: string;
    expectedType: string;
    locale: string;
  }): Promise<readonly SellerListingAttributeOptionRow[]>;
  /** `app_private.seller_listing_attributes_save(...)` (0088). */
  sellerListingAttributesSave(input: {
    userId: string;
    slug: string;
    expectedType: string;
    answers: readonly SellerAttributeAnswerPayload[];
  }): Promise<SellerVocabularyWriteResult>;
  /** `app_private.seller_listing_tag_choices(...)` (0088). */
  sellerListingTagChoices(input: {
    userId: string;
    slug: string;
    expectedType: string;
    locale: string;
  }): Promise<readonly SellerListingTagChoiceRow[]>;
  /** `app_private.seller_listing_tags_save(...)` (0088). */
  sellerListingTagsSave(input: {
    userId: string;
    slug: string;
    expectedType: string;
    tags: readonly string[];
  }): Promise<SellerVocabularyWriteResult>;
}

@Injectable()
export class SellerVocabularyService {
  private readonly logger = new Logger(SellerVocabularyService.name);

  constructor(@Inject(SELLER_VOCABULARY_STORE) private readonly store: SellerVocabularyStore) {}

  /**
   * The questions one listing is asked, with whatever it already answers.
   *
   * The context read comes first and decides 404 on its own, because a row-shaped reader cannot tell a listing
   * that is not the caller's from one whose category asks nothing: both are no rows, and guessing between them
   * would either report an absence that is really an empty form, or hand an empty form to somebody who does not
   * own the listing.
   */
  async attributes(
    userId: string,
    slug: string,
    surface: SellerVocabularySurface,
    locale: string,
  ): Promise<{ readonly attributes: readonly SellerListingAttribute[]; readonly isEditable: boolean }> {
    const context = await this.#context(userId, slug, surface);
    const rows = await this.#read(() =>
      this.store.sellerListingAttributes({ userId, slug, expectedType: surface, locale }),
    );
    const options = await this.#read(() =>
      this.store.sellerListingAttributeOptions({ userId, slug, expectedType: surface, locale }),
    );

    const byDefinition = new Map<string, SellerAttributeOption[]>();
    const valueOfOption = new Map<string, string>();
    for (const option of options) {
      valueOfOption.set(option.optionId, option.value);
      const list = byDefinition.get(option.definitionId);
      const choice = { value: option.value, label: option.label };
      if (list === undefined) byDefinition.set(option.definitionId, [choice]);
      else list.push(choice);
    }

    return {
      attributes: rows.map((row) => ({
        key: row.key,
        label: row.label,
        dataType: this.#dataType(row.dataType),
        unit: row.unit,
        isRequired: row.isRequired,
        sortOrder: row.sortOrder,
        text: row.valueText,
        number: row.valueNumber,
        boolean: row.valueBoolean,
        // An id with no option behind it would mean the two readers disagreed; it is dropped rather than
        // forwarded as a value nothing can render, and the attribute still reports its other answers.
        options: row.optionIds.flatMap((id) => {
          const value = valueOfOption.get(id);
          return value === undefined ? [] : [value];
        }),
        choices: byDefinition.get(row.definitionId) ?? [],
      })),
      isEditable: context.isEditable,
    };
  }

  /** Replaces every answer. What is left out is cleared, which is how a seller empties a field. */
  async saveAttributes(
    userId: string,
    slug: string,
    surface: SellerVocabularySurface,
    request: SaveSellerListingAttributesRequest,
  ): Promise<void> {
    const answers = request.answers.map((answer) => this.#payload(answer));
    await this.#write(() =>
      this.store.sellerListingAttributesSave({ userId, slug, expectedType: surface, answers }),
    );
  }

  /** Every active tag, each marked with whether this listing carries it. */
  async tags(
    userId: string,
    slug: string,
    surface: SellerVocabularySurface,
    locale: string,
  ): Promise<{ readonly tags: readonly SellerListingTagChoice[]; readonly isEditable: boolean }> {
    const context = await this.#context(userId, slug, surface);
    const rows = await this.#read(() =>
      this.store.sellerListingTagChoices({ userId, slug, expectedType: surface, locale }),
    );
    return {
      tags: rows.map((row) => ({ slug: row.slug, name: row.label, isSelected: row.isSelected })),
      isEditable: context.isEditable,
    };
  }

  /** Replaces the whole selection. An unknown or hidden tag voids all of it rather than being dropped. */
  async saveTags(
    userId: string,
    slug: string,
    surface: SellerVocabularySurface,
    tags: readonly string[],
  ): Promise<void> {
    await this.#write(() => this.store.sellerListingTagsSave({ userId, slug, expectedType: surface, tags }));
  }

  /**
   * One validated answer becomes one jsonb member.
   *
   * The discriminant chooses the field, so a request cannot carry two kinds of value at once and this method
   * cannot build a payload the database's own one-value constraint would refuse.
   */
  #payload(answer: SaveSellerListingAttributesRequest['answers'][number]): SellerAttributeAnswerPayload {
    switch (answer.kind) {
      case 'text':
        return { key: answer.key, text: answer.text };
      case 'number':
        return { key: answer.key, number: answer.number };
      case 'boolean':
        return { key: answer.key, boolean: answer.boolean };
      default:
        return { key: answer.key, options: answer.options };
    }
  }

  async #context(
    userId: string,
    slug: string,
    surface: SellerVocabularySurface,
  ): Promise<SellerVocabularyContextRow> {
    const context = await this.#read(() =>
      this.store.sellerListingVocabularyContext({ userId, slug, expectedType: surface }),
    );
    if (context.outcome === 'not_found') throw new SellerListingNotFoundError();
    if (context.outcome !== 'found') {
      this.logger.error('A seller vocabulary read returned an outcome this service does not understand.');
      throw new SellerIdentityUnavailableError(new Error('unexpected outcome'));
    }
    return context;
  }

  async #read<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // No detail and nothing about the rows: an answer is seller-written prose, and the way to keep it out of
      // a log is to have no line that could take it.
      this.logger.error('A seller vocabulary read could not be completed.');
      throw new SellerIdentityUnavailableError(error);
    }
  }

  /**
   * One write, and the one place an outcome becomes an error.
   *
   * `invalid` is 0011's validation trigger having refused: a value of the wrong kind for its attribute, an option
   * that is not that attribute's or is hidden, more than one option on a single-select, an unknown tag, or an
   * attribute this category does not ask about. It is never an unanswered required attribute. An outcome outside
   * 0088's vocabulary is a 503 rather than a success, because guessing is how a refusal turns into a silent write.
   */
  async #write(run: () => Promise<SellerVocabularyWriteResult>): Promise<void> {
    let result: SellerVocabularyWriteResult;
    try {
      result = await run();
    } catch (error) {
      this.logger.error('A seller vocabulary write could not be completed.');
      throw new SellerIdentityUnavailableError(error);
    }

    if (result.outcome === 'not_found') throw new SellerListingNotFoundError();
    if (result.outcome === 'not_editable') throw new SellerListingNotEditableError();
    if (result.outcome === 'invalid') throw new SellerVocabularyAnswerRefusedError();
    if (result.outcome !== 'saved') {
      this.logger.error('A seller vocabulary write returned an outcome this service does not understand.');
      throw new SellerIdentityUnavailableError(new Error('unexpected outcome'));
    }
  }

  #dataType(value: string): AttributeDataType {
    if (!(ATTRIBUTE_DATA_TYPES as readonly string[]).includes(value)) {
      this.logger.error('A listing attribute carried a data type this API does not know.');
      throw new SellerIdentityUnavailableError(new Error('unknown attribute data type'));
    }
    return value as AttributeDataType;
  }
}
