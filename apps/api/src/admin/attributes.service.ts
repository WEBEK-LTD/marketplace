import { Inject, Injectable } from '@nestjs/common';
import {
  ATTRIBUTE_DATA_TYPES,
  type AdminAttributeDefinition,
  type AdminAttributeOption,
  type AdminCategoryAttribute,
  type AdminTag,
  type AttributeDataType,
} from '@repo/contracts';
import { StaffConsoleService } from './staff-console.service.js';
import { isAal2 } from '../auth/access-token-claims.js';
import {
  VocabularyNotFoundError,
  VocabularyRefusedError,
  VocabularyUnavailableError,
  type VocabularyRefusalCode,
} from './attributes.errors.js';

/**
 * The structured attribute vocabulary, the tag vocabulary, and which attributes each category asks for.
 *
 * **The rules are the database's.** Migrations 0010 and 0011 own the shape of an attribute, an option and a tag,
 * and 0088's named functions own the permission test. This service authorizes the caller, calls one function and
 * maps what comes back; a refusal here is always a SQLSTATE translated and never a rule restated.
 *
 * **Three keys, and each one means only itself.** `catalog.attribute.manage` governs the attribute vocabulary,
 * `catalog.tag.manage` the tag vocabulary, and `catalog.category.manage` — not the attribute key — governs which
 * attributes a category asks for, because that is what `category_attributes`' own write policy names. No new
 * permission key was invented for this increment, and there is deliberately no read key on either vocabulary:
 * the people who maintain it are the people who may see it.
 *
 * **Authorization runs in the one order the project uses everywhere.** The provider validates the token, the
 * assurance level comes from that validated token, the database returns the effective permissions under 0003's
 * `requires_mfa` rule, and then the `app_private` function re-applies the same test with the key pinned as a
 * literal. No role name is tested in application code.
 */

export const ATTRIBUTE_MANAGE = 'catalog.attribute.manage';
export const TAG_MANAGE = 'catalog.tag.manage';
export const CATEGORY_READ = 'catalog.category.read';

export const ATTRIBUTES_STORE = Symbol('ATTRIBUTES_STORE');

export interface AttributeDefinitionDbRow {
  readonly definitionId: string;
  readonly key: string;
  readonly dataType: string;
  readonly unit: string | null;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly isFilterable: boolean;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly optionCount: number;
  readonly categoryCount: number;
  readonly answerCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AttributeOptionDbRow {
  readonly optionId: string;
  readonly value: string;
  readonly labelEn: string;
  readonly labelAr: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly answerCount: number;
}

export interface TagDbRow {
  readonly tagId: string;
  readonly slug: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly isActive: boolean;
  readonly usageCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CategoryAttributeDbRow {
  readonly definitionId: string;
  readonly key: string;
  readonly dataType: string;
  readonly unit: string | null;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly definitionIsActive: boolean;
  readonly isRequired: boolean;
  readonly isFilterable: boolean;
  readonly sortOrder: number;
  readonly optionCount: number;
}

export interface AttributesStore {
  attributeCanManage(input: { userId: string; isAal2: boolean }): Promise<boolean>;
  tagCanManage(input: { userId: string; isAal2: boolean }): Promise<boolean>;
  categoryCanManage(input: { userId: string; isAal2: boolean }): Promise<boolean>;
  attributeDefinitionsForStaff(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly AttributeDefinitionDbRow[]>;
  attributeDefinitionForStaff(input: {
    userId: string;
    isAal2: boolean;
    definitionId: string;
  }): Promise<AttributeDefinitionDbRow | null>;
  attributeOptionsForStaff(input: {
    userId: string;
    isAal2: boolean;
    definitionId: string;
  }): Promise<readonly AttributeOptionDbRow[]>;
  attributeDefinitionCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    key: string;
    dataType: string;
    nameEn: string;
    nameAr: string;
    unit: string | null;
    isFilterable: boolean;
    sortOrder: number;
  }): Promise<string>;
  attributeDefinitionUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    definitionId: string;
    nameEn: string;
    nameAr: string;
    unit: string | null;
    isFilterable: boolean;
    sortOrder: number;
  }): Promise<boolean>;
  attributeDefinitionStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    definitionId: string;
    isActive: boolean;
  }): Promise<boolean>;
  attributeOptionCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    definitionId: string;
    value: string;
    labelEn: string;
    labelAr: string;
    sortOrder: number;
  }): Promise<string>;
  attributeOptionUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    optionId: string;
    labelEn: string;
    labelAr: string;
    sortOrder: number;
  }): Promise<boolean>;
  attributeOptionStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    optionId: string;
    isActive: boolean;
  }): Promise<boolean>;
  tagsForStaff(input: { userId: string; isAal2: boolean }): Promise<readonly TagDbRow[]>;
  tagCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
    nameEn: string;
    nameAr: string;
  }): Promise<string>;
  tagUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    tagId: string;
    nameEn: string;
    nameAr: string;
  }): Promise<boolean>;
  tagStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    tagId: string;
    isActive: boolean;
  }): Promise<boolean>;
  categoryAttributesForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
  }): Promise<readonly CategoryAttributeDbRow[]>;
  categoryAttributeAttachForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    definitionId: string;
    isRequired: boolean;
    isFilterable: boolean;
    sortOrder: number;
  }): Promise<boolean>;
  categoryAttributeDetachForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    definitionId: string;
  }): Promise<boolean>;
}

/**
 * Which refusal each SQLSTATE is, with our own sentence.
 *
 * The database's own message is deliberately **not** forwarded: it names tables and constraints, neither of which
 * belongs in an answer a browser receives.
 *
 *   `23001` restrict_violation — showing a select attribute with no active option, or giving an option to an
 *                               attribute that is not a select one
 *   `23505` unique_violation   — the key, the option value within its attribute, or the tag slug is taken
 *   `23514` check_violation    — a format, a blank label, or a unit on an attribute that is not a number
 */
const KEY_TAKEN = {
  code: 'ATTRIBUTE_KEY_TAKEN' as const,
  detail: 'That name is already in use and cannot be changed once it has been given.',
};
const NOT_ANSWERABLE = {
  code: 'ATTRIBUTE_NOT_ANSWERABLE' as const,
  detail: 'That would leave a question sellers cannot answer, or an answer they cannot give.',
};
const VALUE_NOT_ALLOWED = {
  code: 'ATTRIBUTE_VALUE_NOT_ALLOWED' as const,
  detail: 'That value is longer or differently shaped than this field allows.',
};

function sqlstateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

@Injectable()
export class AttributesAdminService {
  constructor(
    private readonly staff: StaffConsoleService,
    @Inject(ATTRIBUTES_STORE) private readonly store: AttributesStore,
  ) {}

  // -------------------------------------------------------------------------------------------------
  // The attribute vocabulary
  // -------------------------------------------------------------------------------------------------
  /** The whole vocabulary, including the hidden: a console that hid those could not bring one back. */
  async definitions(
    accessToken: string,
  ): Promise<{ readonly attributes: readonly AdminAttributeDefinition[]; readonly canManage: boolean }> {
    const caller = await this.#caller(accessToken, ATTRIBUTE_MANAGE);
    const rows = await this.#read(() => this.store.attributeDefinitionsForStaff(caller));
    return { attributes: rows.map((row) => this.#definition(row)), canManage: true };
  }

  /** One definition with its options. Empty options for a text, number or boolean attribute. */
  async definition(
    accessToken: string,
    definitionId: string,
  ): Promise<{
    readonly attribute: AdminAttributeDefinition;
    readonly options: readonly AdminAttributeOption[];
    readonly canManage: boolean;
  }> {
    const caller = await this.#caller(accessToken, ATTRIBUTE_MANAGE);
    const row = await this.#read(() => this.store.attributeDefinitionForStaff({ ...caller, definitionId }));
    if (row === null) throw new VocabularyNotFoundError();
    const options = await this.#read(() => this.store.attributeOptionsForStaff({ ...caller, definitionId }));
    return {
      attribute: this.#definition(row),
      options: options.map((option) => ({
        optionId: option.optionId,
        value: option.value,
        labelEn: option.labelEn,
        labelAr: option.labelAr,
        sortOrder: option.sortOrder,
        isActive: option.isActive,
        answerCount: option.answerCount,
      })),
      canManage: true,
    };
  }

  async createDefinition(
    accessToken: string,
    input: {
      readonly key: string;
      readonly dataType: string;
      readonly nameEn: string;
      readonly nameAr: string;
      readonly unit: string | null;
      readonly isFilterable: boolean;
      readonly sortOrder: number;
    },
  ): Promise<string> {
    const caller = await this.#caller(accessToken, ATTRIBUTE_MANAGE);
    return this.#write(() => this.store.attributeDefinitionCreateForStaff({ ...caller, ...input }));
  }

  async updateDefinition(
    accessToken: string,
    definitionId: string,
    input: {
      readonly nameEn: string;
      readonly nameAr: string;
      readonly unit: string | null;
      readonly isFilterable: boolean;
      readonly sortOrder: number;
    },
  ): Promise<boolean> {
    const caller = await this.#caller(accessToken, ATTRIBUTE_MANAGE);
    const changed = await this.#write(() =>
      this.store.attributeDefinitionUpdateForStaff({ ...caller, definitionId, ...input }),
    );
    if (!changed) throw new VocabularyNotFoundError();
    return changed;
  }

  async setDefinitionState(accessToken: string, definitionId: string, isActive: boolean): Promise<boolean> {
    const caller = await this.#caller(accessToken, ATTRIBUTE_MANAGE);
    const changed = await this.#write(() =>
      this.store.attributeDefinitionStateForStaff({ ...caller, definitionId, isActive }),
    );
    if (!changed) throw new VocabularyNotFoundError();
    return changed;
  }

  async createOption(
    accessToken: string,
    definitionId: string,
    input: {
      readonly value: string;
      readonly labelEn: string;
      readonly labelAr: string;
      readonly sortOrder: number;
    },
  ): Promise<string> {
    const caller = await this.#caller(accessToken, ATTRIBUTE_MANAGE);
    return this.#write(() => this.store.attributeOptionCreateForStaff({ ...caller, definitionId, ...input }));
  }

  async updateOption(
    accessToken: string,
    optionId: string,
    input: { readonly labelEn: string; readonly labelAr: string; readonly sortOrder: number },
  ): Promise<boolean> {
    const caller = await this.#caller(accessToken, ATTRIBUTE_MANAGE);
    const changed = await this.#write(() =>
      this.store.attributeOptionUpdateForStaff({ ...caller, optionId, ...input }),
    );
    if (!changed) throw new VocabularyNotFoundError();
    return changed;
  }

  async setOptionState(accessToken: string, optionId: string, isActive: boolean): Promise<boolean> {
    const caller = await this.#caller(accessToken, ATTRIBUTE_MANAGE);
    const changed = await this.#write(() =>
      this.store.attributeOptionStateForStaff({ ...caller, optionId, isActive }),
    );
    if (!changed) throw new VocabularyNotFoundError();
    return changed;
  }

  // -------------------------------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------------------------------
  async tags(accessToken: string): Promise<{ readonly tags: readonly AdminTag[]; readonly canManage: boolean }> {
    const caller = await this.#caller(accessToken, TAG_MANAGE);
    const rows = await this.#read(() => this.store.tagsForStaff(caller));
    return {
      tags: rows.map((row) => ({
        tagId: row.tagId,
        slug: row.slug,
        nameEn: row.nameEn,
        nameAr: row.nameAr,
        isActive: row.isActive,
        usageCount: row.usageCount,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      canManage: true,
    };
  }

  async createTag(
    accessToken: string,
    input: { readonly slug: string; readonly nameEn: string; readonly nameAr: string },
  ): Promise<string> {
    const caller = await this.#caller(accessToken, TAG_MANAGE);
    return this.#write(() => this.store.tagCreateForStaff({ ...caller, ...input }));
  }

  async updateTag(
    accessToken: string,
    tagId: string,
    input: { readonly nameEn: string; readonly nameAr: string },
  ): Promise<boolean> {
    const caller = await this.#caller(accessToken, TAG_MANAGE);
    const changed = await this.#write(() => this.store.tagUpdateForStaff({ ...caller, tagId, ...input }));
    if (!changed) throw new VocabularyNotFoundError();
    return changed;
  }

  async setTagState(accessToken: string, tagId: string, isActive: boolean): Promise<boolean> {
    const caller = await this.#caller(accessToken, TAG_MANAGE);
    const changed = await this.#write(() => this.store.tagStateForStaff({ ...caller, tagId, isActive }));
    if (!changed) throw new VocabularyNotFoundError();
    return changed;
  }

  // -------------------------------------------------------------------------------------------------
  // Which attributes a category asks for
  // -------------------------------------------------------------------------------------------------
  /**
   * The category key, not the attribute key.
   *
   * `category_attributes`' own write policy names `catalog.category.manage`, so this is the one surface here
   * where holding the attribute key grants nothing: defining an attribute and deciding which categories ask for
   * it are separate authorities, and this service does not blur them.
   */
  async categoryAttributes(
    accessToken: string,
    categoryId: string,
  ): Promise<{ readonly attributes: readonly AdminCategoryAttribute[]; readonly canManage: boolean }> {
    const caller = await this.#caller(accessToken, CATEGORY_READ);
    const rows = await this.#read(() => this.store.categoryAttributesForStaff({ ...caller, categoryId }));
    const canManage = await this.#read(() => this.store.categoryCanManage(caller));
    return {
      attributes: rows.map((row) => ({
        definitionId: row.definitionId,
        key: row.key,
        dataType: this.#dataType(row.dataType),
        unit: row.unit,
        nameEn: row.nameEn,
        nameAr: row.nameAr,
        isRequired: row.isRequired,
        isFilterable: row.isFilterable,
        sortOrder: row.sortOrder,
        isActive: row.definitionIsActive,
        optionCount: row.optionCount,
      })),
      canManage,
    };
  }

  async attachCategoryAttribute(
    accessToken: string,
    categoryId: string,
    input: {
      readonly definitionId: string;
      readonly isRequired: boolean;
      readonly isFilterable: boolean;
      readonly sortOrder: number;
    },
  ): Promise<boolean> {
    const caller = await this.#caller(accessToken, CATEGORY_READ);
    const changed = await this.#write(() =>
      this.store.categoryAttributeAttachForStaff({ ...caller, categoryId, ...input }),
    );
    if (!changed) throw new VocabularyNotFoundError();
    return changed;
  }

  /**
   * Stop a category asking for one attribute.
   *
   * An attribute the category does not ask for answers `changed: false` rather than 404: the category was found
   * and nothing needed doing, which is a different statement from "no such category".
   */
  async detachCategoryAttribute(
    accessToken: string,
    categoryId: string,
    definitionId: string,
  ): Promise<boolean> {
    const caller = await this.#caller(accessToken, CATEGORY_READ);
    return this.#write(() =>
      this.store.categoryAttributeDetachForStaff({ ...caller, categoryId, definitionId }),
    );
  }

  // -------------------------------------------------------------------------------------------------
  #definition(row: AttributeDefinitionDbRow): AdminAttributeDefinition {
    return {
      definitionId: row.definitionId,
      key: row.key,
      dataType: this.#dataType(row.dataType),
      unit: row.unit,
      nameEn: row.nameEn,
      nameAr: row.nameAr,
      isFilterable: row.isFilterable,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      optionCount: row.optionCount,
      categoryCount: row.categoryCount,
      answerCount: row.answerCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * A data type the contract does not know is a 503 rather than a value forwarded.
   *
   * The column's check constraint and the contract's enum are the same five today; if they ever disagree, a
   * browser receiving a sixth kind would be shown a field nothing can render, and silence would be the bug.
   */
  #dataType(value: string): AttributeDataType {
    if (!(ATTRIBUTE_DATA_TYPES as readonly string[]).includes(value)) {
      throw new VocabularyUnavailableError(new Error('unknown attribute data type'));
    }
    return value as AttributeDataType;
  }

  /**
   * The caller, in the one order this project uses: the provider validates the token, the database says what the
   * account effectively holds, and the assurance level comes from that same validated token.
   *
   * The key this surface needs is checked here **and** re-applied inside every `app_private` function with the
   * key pinned as a literal. Two checks rather than one, deliberately: the first keeps a request that cannot
   * succeed from reaching the database, and the second is the one that actually decides.
   */
  async #caller(
    accessToken: string,
    permission: string,
  ): Promise<{ readonly userId: string; readonly isAal2: boolean }> {
    const session = await this.staff.forToken(accessToken);
    if (!session.permissions.includes(permission)) throw new VocabularyNotFoundError();
    return { userId: session.id, isAal2: isAal2(accessToken) };
  }

  async #read<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new VocabularyUnavailableError(error);
    }
  }

  /**
   * One write, with the database's refusals translated and nothing else let through.
   *
   * `42501` is the database refusing a caller without the key, and it becomes the same `NOT_FOUND` as an absence.
   * The three mapped SQLSTATEs become 409s. Everything else — including `23502`, which would mean this service
   * sent something it should have caught — becomes a 503 rather than a confident refusal about a rule that does
   * not exist.
   */
  async #write<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '42501') throw new VocabularyNotFoundError();
      if (sqlstate === '23001') throw this.#refused(NOT_ANSWERABLE);
      if (sqlstate === '23505') throw this.#refused(KEY_TAKEN);
      if (sqlstate === '23514') throw this.#refused(VALUE_NOT_ALLOWED);
      // A foreign key: an attribute, category or option that does not exist. The caller named something absent,
      // which is the same answer as naming an absent attribute.
      if (sqlstate === '23503') throw new VocabularyNotFoundError();
      throw new VocabularyUnavailableError(error);
    }
  }

  #refused(refusal: { readonly code: VocabularyRefusalCode; readonly detail: string }): VocabularyRefusedError {
    return new VocabularyRefusedError(refusal.code, refusal.detail);
  }
}
