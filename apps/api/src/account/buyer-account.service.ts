import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ACCOUNT_MAX_LIMIT,
  type Address,
  type AddressInput,
  type BuyerProfile,
  type BuyerSettings,
  type CountryReference,
  type FavoriteItem,
  type ProblemCode,
  type ProfileStatus,
  type SavedSearch,
  type SavedSearchInput,
  type UpdateBuyerProfileRequest,
  type UpdateBuyerSettingsRequest,
} from '@repo/contracts';
import { RequestValidationException } from '../common/request-validation.exception.js';
import {
  decodeFavoritesCursor,
  decodeSavedSearchesCursor,
  encodeFavoritesCursor,
  encodeSavedSearchesCursor,
} from './account-cursor.js';

/* ------------------------------------------------------------------------------------------------ */
/* Failures                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The cursor could not be used (Phase 7-E).
 *
 * One code for a malformed cursor, a tampered one, one of the wrong kind and one from a version this API
 * no longer reads: the client's remedy is identical in all four — drop it and start again — and naming
 * which structural check failed would only help somebody mapping the format.
 */
export class InvalidAccountCursorError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'ACCOUNT_CURSOR_INVALID',
  };

  constructor() {
    super('The list position could not be used.');
    this.name = 'InvalidAccountCursorError';
  }
}

/**
 * There is no such row for this account.
 *
 * A 404 with the platform's ordinary code, and deliberately the same answer for a row that does not
 * exist and one that belongs to somebody else. The readers and writers of migration 0067 are scoped to
 * the caller in the statement, so the two are genuinely indistinguishable here — there is no branch that
 * could tell them apart, which is what makes the guarantee structural rather than a promise.
 */
export class AccountRowNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'AccountRowNotFoundError';
  }
}

/** The caller already has a saved search by that name. Per account, so it names nobody else. */
export class SavedSearchNameTakenError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SAVED_SEARCH_NAME_TAKEN',
  };

  constructor() {
    super('You already have a saved search with that name.');
    this.name = 'SavedSearchNameTakenError';
  }
}

/**
 * D17: an address used for shipping must sit in a marketplace-enabled country.
 *
 * Its own code because the caller can act on it — choose another country, or keep the address for
 * billing only — and a bare validation failure would send somebody looking at their street name.
 */
export class AddressCountryNotShippableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'ADDRESS_COUNTRY_NOT_SHIPPABLE',
  };

  constructor() {
    super('That country is not available for shipping addresses.');
    this.name = 'AddressCountryNotShippableError';
  }
}

/**
 * A field the database refused: an unknown country, locale or timezone.
 *
 * A validation failure rather than a problem code of its own, and it extends the pipe's own exception
 * so the refused field travels in `errors` exactly as a schema failure does. The caller sees one kind
 * of answer for "that value is not acceptable" whether the schema or the database decided it, and the
 * form can point at the same field either way.
 */
export class AccountFieldInvalidError extends RequestValidationException {
  constructor(path: string, message: string) {
    super([{ path, message }]);
    this.name = 'AccountFieldInvalidError';
  }
}

/** The reader or the writer could not be reached. Never rendered as an empty list. */
export class AccountUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'AccountUnavailableError';
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Rows, as the driver returns them                                                                  */
/* ------------------------------------------------------------------------------------------------ */

export interface FavoriteRow {
  readonly listingId: string;
  readonly createdAt: Date;
  readonly isAvailable: boolean;
  readonly slug: string | null;
  readonly title: string | null;
  readonly city: string | null;
  readonly priceMinor: string | null;
  readonly currencyCode: string | null;
  readonly currencyMinorUnit: number | null;
  readonly isNegotiable: boolean | null;
  readonly listingTypeCode: string | null;
}

export interface SavedSearchRow {
  readonly id: string;
  readonly name: string;
  readonly query: unknown;
  readonly notify: boolean;
  readonly lastMatchedAt: Date | null;
  readonly lastNotifiedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AddressRow {
  readonly id: string;
  readonly label: string | null;
  readonly purpose: string;
  readonly recipientName: string;
  readonly phoneE164: string;
  readonly countryCode: string;
  readonly governorate: string;
  readonly city: string;
  readonly district: string | null;
  readonly streetAddress: string;
  readonly building: string | null;
  readonly apartment: string | null;
  readonly postalCode: string | null;
  readonly landmark: string | null;
  readonly isDefaultShipping: boolean;
  readonly isDefaultBilling: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BuyerProfileRow {
  readonly id: string;
  readonly displayName: string | null;
  readonly fullName: string | null;
  readonly phoneE164: string | null;
  readonly localeCode: string | null;
  readonly timezone: string;
  readonly status: string;
  readonly emailVerifiedAt: Date | null;
  readonly phoneVerifiedAt: Date | null;
  readonly createdAt: Date;
}

export interface BuyerSettingsRow {
  readonly notifyEmail: boolean;
  readonly notifySms: boolean;
  readonly notifyWhatsapp: boolean;
  readonly notifyInApp: boolean;
  readonly marketingOptIn: boolean;
  readonly digitStyle: string | null;
}

export interface CountryRow {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly phoneCode: string;
  readonly isMarketplaceEnabled: boolean;
}

/* ------------------------------------------------------------------------------------------------ */
/* The store                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The sixteen database operations the buyer account surfaces need, and nothing else.
 *
 * Every method takes the account as its first argument, and that value is always one the API resolved
 * from the caller's own access token. None of them takes two accounts, and none takes a role, a
 * permission or a status.
 */
export interface BuyerAccountStore {
  buyerFavorites(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly FavoriteRow[]>;
  buyerFavoriteAdd(input: { userId: string; listingId: string }): Promise<'added' | 'exists' | 'not_found'>;
  buyerFavoriteRemove(input: { userId: string; listingId: string }): Promise<boolean>;

  buyerSavedSearches(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SavedSearchRow[]>;
  buyerSavedSearchCreate(input: {
    userId: string;
    name: string;
    query: unknown;
    notify: boolean;
  }): Promise<{ outcome: 'created' | 'duplicate_name'; id: string | null }>;
  buyerSavedSearchUpdate(input: {
    userId: string;
    id: string;
    name: string;
    query: unknown;
    notify: boolean;
  }): Promise<'updated' | 'not_found' | 'duplicate_name'>;
  buyerSavedSearchDelete(input: { userId: string; id: string }): Promise<boolean>;

  buyerAddresses(userId: string): Promise<readonly AddressRow[]>;
  buyerAddressCreate(input: {
    userId: string;
    address: AddressInput;
  }): Promise<{ outcome: 'created' | 'country_not_enabled' | 'invalid_country'; id: string | null }>;
  buyerAddressUpdate(input: {
    userId: string;
    id: string;
    address: AddressInput;
  }): Promise<'updated' | 'not_found' | 'country_not_enabled' | 'invalid_country'>;
  buyerAddressDelete(input: { userId: string; id: string }): Promise<boolean>;

  buyerProfile(userId: string): Promise<BuyerProfileRow | null>;
  buyerProfileUpdate(input: {
    userId: string;
    displayName: string | null;
    fullName: string | null;
    localeCode: string | null;
    timezone: string | null;
  }): Promise<'updated' | 'not_found' | 'invalid_locale' | 'invalid_timezone'>;

  buyerSettings(userId: string): Promise<BuyerSettingsRow | null>;
  buyerSettingsUpdate(input: { userId: string; settings: UpdateBuyerSettingsRequest }): Promise<boolean>;

  referenceCountries(): Promise<readonly CountryRow[]>;
}

export const BUYER_ACCOUNT_STORE = Symbol('BUYER_ACCOUNT_STORE');

/* ------------------------------------------------------------------------------------------------ */
/* Pages                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export interface FavoritesPage {
  readonly items: readonly FavoriteItem[];
  readonly nextCursor: string | null;
}

export interface SavedSearchesPage {
  readonly items: readonly SavedSearch[];
  readonly nextCursor: string | null;
}

/** ISO-8601 for a timestamp, or null. The only date formatting this service does. */
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

const PROFILE_STATUSES = new Set<ProfileStatus>(['active', 'suspended', 'deleted']);

/**
 * The buyer account surfaces (Phase 7-E).
 *
 * Every question of authority is answered by migration 0067 and by 0005 and 0013 before it: whose rows
 * these are, what may be written, what the schema refuses. **None of it is re-decided here.** This layer
 * decodes and encodes the opaque cursors, converts rows into the shared contract, turns the writers'
 * named outcomes into the approved problems, and turns a database failure into the approved 503 — and
 * that is the whole of it.
 *
 * Three properties are worth stating because they are what the tests hold onto.
 *
 * **The caller is never named by a request.** `userId` is always the value the API resolved from the
 * caller's own access token before this service was reached. No method takes a user identifier from
 * anywhere else, and every reader and writer puts that account in its own predicate — so a row belonging
 * to somebody else is *absent from the result*, not refused from it. There is nothing here to leak,
 * because there is no branch that could tell the two apart.
 *
 * **A write reports what moved.** `changed` is the writer's own row count, which makes idempotency
 * observable: favouriting a listing that is already saved, or removing an address that is already gone,
 * reports false and is still a success.
 *
 * **Nothing here schedules anything.** A saved search with `notify` on is a stored preference: no job is
 * enqueued, no match is computed and no notification is created, because no matching engine exists in
 * this project. That is not an omission this layer papers over — it is the absence the increment was
 * told to preserve.
 */
@Injectable()
export class BuyerAccountService {
  private readonly logger = new Logger(BuyerAccountService.name);

  constructor(@Inject(BUYER_ACCOUNT_STORE) private readonly store: BuyerAccountStore) {}

  /* ---------------------------------------------------------------------------------------------- */
  /* Favorites                                                                                       */
  /* ---------------------------------------------------------------------------------------------- */

  async favorites(input: {
    userId: string;
    limit: number;
    cursor: string | null;
  }): Promise<FavoritesPage> {
    const position = this.position(input.cursor, decodeFavoritesCursor);
    const limit = Math.min(Math.max(input.limit, 1), ACCOUNT_MAX_LIMIT);

    const rows = await this.read(() =>
      this.store.buyerFavorites({
        userId: input.userId,
        limit: limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      }),
    );

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last !== undefined
        ? encodeFavoritesCursor({ createdAt: last.createdAt, id: last.listingId })
        : null;

    return { items: page.map((row) => this.favoriteItem(row)), nextCursor };
  }

  async addFavorite(input: { userId: string; listingId: string }): Promise<{ changed: boolean }> {
    const outcome = await this.read(() => this.store.buyerFavoriteAdd(input));
    // A listing that is not publicly visible is reported as absent, exactly as one that does not exist:
    // the admission test is the table's own RLS check, and saying which applied would disclose the
    // difference between a withdrawn listing and an imaginary one.
    if (outcome === 'not_found') throw new AccountRowNotFoundError();
    return { changed: outcome === 'added' };
  }

  async removeFavorite(input: { userId: string; listingId: string }): Promise<{ changed: boolean }> {
    return { changed: await this.read(() => this.store.buyerFavoriteRemove(input)) };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Saved searches                                                                                  */
  /* ---------------------------------------------------------------------------------------------- */

  async savedSearches(input: {
    userId: string;
    limit: number;
    cursor: string | null;
  }): Promise<SavedSearchesPage> {
    const position = this.position(input.cursor, decodeSavedSearchesCursor);
    const limit = Math.min(Math.max(input.limit, 1), ACCOUNT_MAX_LIMIT);

    const rows = await this.read(() =>
      this.store.buyerSavedSearches({
        userId: input.userId,
        limit: limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      }),
    );

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last !== undefined
        ? encodeSavedSearchesCursor({ createdAt: last.createdAt, id: last.id })
        : null;

    return { items: page.map((row) => this.savedSearch(row)), nextCursor };
  }

  async createSavedSearch(input: { userId: string; body: SavedSearchInput }): Promise<{ id: string }> {
    const result = await this.read(() =>
      this.store.buyerSavedSearchCreate({
        userId: input.userId,
        name: input.body.name,
        query: input.body.query,
        notify: input.body.notify ?? false,
      }),
    );
    if (result.outcome === 'duplicate_name' || result.id === null) throw new SavedSearchNameTakenError();
    return { id: result.id };
  }

  async updateSavedSearch(input: {
    userId: string;
    id: string;
    body: SavedSearchInput;
  }): Promise<{ changed: boolean }> {
    const outcome = await this.read(() =>
      this.store.buyerSavedSearchUpdate({
        userId: input.userId,
        id: input.id,
        name: input.body.name,
        query: input.body.query,
        notify: input.body.notify ?? false,
      }),
    );
    if (outcome === 'duplicate_name') throw new SavedSearchNameTakenError();
    if (outcome === 'not_found') throw new AccountRowNotFoundError();
    return { changed: true };
  }

  async deleteSavedSearch(input: { userId: string; id: string }): Promise<{ changed: boolean }> {
    return { changed: await this.read(() => this.store.buyerSavedSearchDelete(input)) };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Addresses                                                                                       */
  /* ---------------------------------------------------------------------------------------------- */

  async addresses(userId: string): Promise<{ items: readonly Address[] }> {
    const rows = await this.read(() => this.store.buyerAddresses(userId));
    return { items: rows.map((row) => this.address(row)) };
  }

  async createAddress(input: { userId: string; body: AddressInput }): Promise<{ id: string }> {
    const result = await this.read(() =>
      this.store.buyerAddressCreate({ userId: input.userId, address: input.body }),
    );
    if (result.outcome === 'country_not_enabled') throw new AddressCountryNotShippableError();
    if (result.outcome === 'invalid_country' || result.id === null) {
      throw new AccountFieldInvalidError('countryCode', 'That country is not recognised.');
    }
    return { id: result.id };
  }

  async updateAddress(input: {
    userId: string;
    id: string;
    body: AddressInput;
  }): Promise<{ changed: boolean }> {
    const outcome = await this.read(() =>
      this.store.buyerAddressUpdate({ userId: input.userId, id: input.id, address: input.body }),
    );
    if (outcome === 'country_not_enabled') throw new AddressCountryNotShippableError();
    if (outcome === 'invalid_country') {
      throw new AccountFieldInvalidError('countryCode', 'That country is not recognised.');
    }
    if (outcome === 'not_found') throw new AccountRowNotFoundError();
    return { changed: true };
  }

  async deleteAddress(input: { userId: string; id: string }): Promise<{ changed: boolean }> {
    return { changed: await this.read(() => this.store.buyerAddressDelete(input)) };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Profile                                                                                         */
  /* ---------------------------------------------------------------------------------------------- */

  async profile(userId: string): Promise<{ profile: BuyerProfile }> {
    const row = await this.read(() => this.store.buyerProfile(userId));
    // A deleted profile reads as absent, which is the same answer 0052's identity reader gives and the
    // reason a deleted account cannot keep using a live token.
    if (row === null) throw new AccountRowNotFoundError();
    return { profile: this.buyerProfile(row) };
  }

  async updateProfile(input: {
    userId: string;
    body: UpdateBuyerProfileRequest;
  }): Promise<{ changed: boolean }> {
    const outcome = await this.read(() =>
      this.store.buyerProfileUpdate({
        userId: input.userId,
        displayName: input.body.displayName ?? null,
        fullName: input.body.fullName ?? null,
        localeCode: input.body.localeCode ?? null,
        timezone: input.body.timezone ?? null,
      }),
    );
    if (outcome === 'invalid_locale') {
      throw new AccountFieldInvalidError('localeCode', 'That language is not available.');
    }
    if (outcome === 'invalid_timezone') {
      throw new AccountFieldInvalidError('timezone', 'That time zone is not recognised.');
    }
    if (outcome === 'not_found') throw new AccountRowNotFoundError();
    return { changed: true };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Settings                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  async settings(userId: string): Promise<{ settings: BuyerSettings }> {
    const row = await this.read(() => this.store.buyerSettings(userId));
    if (row === null) throw new AccountRowNotFoundError();
    return { settings: this.buyerSettings(row) };
  }

  async updateSettings(input: {
    userId: string;
    body: UpdateBuyerSettingsRequest;
  }): Promise<{ changed: boolean }> {
    const written = await this.read(() =>
      this.store.buyerSettingsUpdate({ userId: input.userId, settings: input.body }),
    );
    if (!written) throw new AccountRowNotFoundError();
    return { changed: true };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Reference                                                                                       */
  /* ---------------------------------------------------------------------------------------------- */

  async countries(): Promise<{ items: readonly CountryReference[] }> {
    const rows = await this.read(() => this.store.referenceCountries());
    return {
      items: rows.map((row) => ({
        code: row.code,
        nameEn: row.nameEn,
        nameAr: row.nameAr,
        phoneCode: row.phoneCode,
        isMarketplaceEnabled: row.isMarketplaceEnabled,
      })),
    };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Conversions                                                                                     */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * One favorite.
   *
   * The card is assembled only when the reader said the listing is still visible **and** every field it
   * needs is present. A partially populated card is treated as no card at all rather than filled in with
   * guesses: the two states a surface has to tell apart are "here it is" and "it is gone", and a card
   * with an invented price would be neither.
   */
  private favoriteItem(row: FavoriteRow): FavoriteItem {
    const complete =
      row.isAvailable &&
      row.slug !== null &&
      row.title !== null &&
      row.currencyCode !== null &&
      row.currencyMinorUnit !== null &&
      row.isNegotiable !== null &&
      row.listingTypeCode !== null;

    return {
      listingId: row.listingId,
      savedAt: row.createdAt.toISOString(),
      isAvailable: row.isAvailable,
      listing: complete
        ? {
            id: row.listingId,
            slug: row.slug as string,
            title: row.title as string,
            city: row.city,
            priceMinor: row.priceMinor === null ? null : String(row.priceMinor),
            currencyCode: row.currencyCode as string,
            currencyMinorUnit: Number(row.currencyMinorUnit),
            isNegotiable: row.isNegotiable as boolean,
            listingTypeCode: row.listingTypeCode as string,
          }
        : null,
    };
  }

  private savedSearch(row: SavedSearchRow): SavedSearch {
    return {
      id: row.id,
      name: row.name,
      // The stored parameters, passed through. A non-object cannot be stored (0013's own constraint), so
      // the fallback is defensive rather than a shape this surface expects to meet.
      query:
        typeof row.query === 'object' && row.query !== null && !Array.isArray(row.query)
          ? (row.query as Record<string, unknown>)
          : {},
      notify: row.notify,
      lastMatchedAt: iso(row.lastMatchedAt),
      lastNotifiedAt: iso(row.lastNotifiedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private address(row: AddressRow): Address {
    return {
      id: row.id,
      label: row.label,
      purpose: row.purpose === 'shipping' || row.purpose === 'billing' ? row.purpose : 'both',
      recipientName: row.recipientName,
      phoneE164: row.phoneE164,
      countryCode: row.countryCode,
      governorate: row.governorate,
      city: row.city,
      district: row.district,
      streetAddress: row.streetAddress,
      building: row.building,
      apartment: row.apartment,
      postalCode: row.postalCode,
      landmark: row.landmark,
      isDefaultShipping: row.isDefaultShipping,
      isDefaultBilling: row.isDefaultBilling,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private buyerProfile(row: BuyerProfileRow): BuyerProfile {
    return {
      id: row.id,
      displayName: row.displayName,
      fullName: row.fullName,
      phoneE164: row.phoneE164,
      localeCode: row.localeCode,
      timezone: row.timezone,
      status: PROFILE_STATUSES.has(row.status as ProfileStatus) ? (row.status as ProfileStatus) : 'active',
      emailVerifiedAt: iso(row.emailVerifiedAt),
      phoneVerifiedAt: iso(row.phoneVerifiedAt),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private buyerSettings(row: BuyerSettingsRow): BuyerSettings {
    return {
      notifyEmail: row.notifyEmail,
      notifySms: row.notifySms,
      notifyWhatsapp: row.notifyWhatsapp,
      notifyInApp: row.notifyInApp,
      marketingOptIn: row.marketingOptIn,
      digitStyle:
        row.digitStyle === 'western' || row.digitStyle === 'arabic_indic' ? row.digitStyle : null,
    };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Plumbing                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  /** A cursor, decoded by the one decoder that belongs to this list, or a refusal. */
  private position(
    cursor: string | null,
    decoder: (value: string) => { createdAt: Date; id: string } | null,
  ): { createdAt: Date; id: string } | null {
    if (cursor === null || cursor === '') return null;
    const decoded = decoder(cursor);
    if (decoded === null) throw new InvalidAccountCursorError();
    return decoded;
  }

  /**
   * One store call, with an unreachable database turned into the approved 503.
   *
   * The failures this service raises deliberately pass through: they are answers, not outages, and
   * wrapping them would turn a name conflict into a service failure.
   */
  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof InvalidAccountCursorError ||
        error instanceof AccountRowNotFoundError ||
        error instanceof SavedSearchNameTakenError ||
        error instanceof AddressCountryNotShippableError ||
        error instanceof AccountFieldInvalidError
      ) {
        throw error;
      }
      // The message is never included: it can carry a constraint name and a row's values.
      this.logger.warn('A buyer account operation could not be completed.');
      throw new AccountUnavailableError(error);
    }
  }
}
