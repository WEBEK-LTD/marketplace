import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  ACCOUNT_DEFAULT_LIMIT,
  ACCOUNT_MAX_LIMIT,
  AddFavoriteRequestSchema,
  AddressInputSchema,
  SESSION_TOKEN_HEADER,
  SavedSearchInputSchema,
  UpdateBuyerProfileRequestSchema,
  UpdateBuyerSettingsRequestSchema,
  parseMessagingLimit,
  type AddFavoriteRequest,
  type AddressCreatedResponse,
  type AddressInput,
  type AddressMutationResponse,
  type AddressesResponse,
  type BuyerProfileMutationResponse,
  type BuyerProfileResponse,
  type BuyerSettingsMutationResponse,
  type BuyerSettingsResponse,
  type CountriesResponse,
  type FavoriteMutationResponse,
  type FavoritesResponse,
  type SavedSearchCreatedResponse,
  type SavedSearchInput,
  type SavedSearchMutationResponse,
  type SavedSearchesResponse,
  type UpdateBuyerProfileRequest,
  type UpdateBuyerSettingsRequest,
} from '@repo/contracts';
import { BuyerAccountService } from '../account/buyer-account.service.js';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { CurrentUserService } from '../users/current-user.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface AccountRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: AccountRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The buyer account surfaces (Phase 7-E): favorites, saved searches, addresses, profile and settings.
 *
 * Every route here is authenticated and every one of them resolves the caller the same way: from their
 * own access token, through {@link CurrentUserService}, which asks the provider whose token it is and
 * then the database whether that account still exists. **No route accepts a user identifier.** There is
 * no parameter, header or body field anywhere below from which a caller could name somebody else — the
 * only path parameters are a listing, a saved search and an address, each of which names a row, never a
 * person.
 *
 * The controller decides nothing about who may read or change what. Ownership is enforced inside the
 * statement in migration 0067, and it is not restated here — restating an authorization rule is how two
 * copies of it start to disagree. A row belonging to somebody else is therefore not refused by this
 * layer; it is simply never matched, which is why every "not found" on these surfaces is genuinely
 * indistinguishable from a row that does not exist.
 *
 * Not here, deliberately: **nothing that changes what an account may do**. No role, no permission, no
 * status, no password, no session control and no second factor. Those live in the flows that own them,
 * and a buyer settings page is not one of them.
 */
@Controller('v1')
export class BuyerAccountController {
  constructor(
    private readonly account: BuyerAccountService,
    private readonly users: CurrentUserService,
  ) {}

  /* ---------------------------------------------------------------------------------------------- */
  /* Favorites                                                                                       */
  /* ---------------------------------------------------------------------------------------------- */

  @Get('users/me/favorites')
  async favorites(
    @Req() request: AccountRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<FavoritesResponse> {
    const userId = await this.caller(request);
    const page = await this.account.favorites({
      userId,
      limit: this.limit(limit),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /**
   * Saves a listing.
   *
   * Idempotent: a listing that is already saved reports `changed: false` and keeps the date it was first
   * saved. A listing that is not publicly visible answers 404, identically to one that does not exist.
   */
  @Post('users/me/favorites')
  @HttpCode(200)
  async addFavorite(
    @Body(new ZodValidationPipe(AddFavoriteRequestSchema)) body: AddFavoriteRequest,
    @Req() request: AccountRequestContext,
  ): Promise<FavoriteMutationResponse> {
    const userId = await this.caller(request);
    return await this.account.addFavorite({ userId, listingId: body.listingId });
  }

  @Delete('users/me/favorites/:listingId')
  @HttpCode(200)
  async removeFavorite(
    @Param('listingId') listingId: string,
    @Req() request: AccountRequestContext,
  ): Promise<FavoriteMutationResponse> {
    const userId = await this.caller(request);
    return await this.account.removeFavorite({
      userId,
      listingId: this.identifier(listingId, 'listingId'),
    });
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Saved searches                                                                                  */
  /* ---------------------------------------------------------------------------------------------- */

  @Get('users/me/saved-searches')
  async savedSearches(
    @Req() request: AccountRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SavedSearchesResponse> {
    const userId = await this.caller(request);
    const page = await this.account.savedSearches({
      userId,
      limit: this.limit(limit),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /**
   * Stores a search.
   *
   * `notify` is a stored preference and nothing else: this creates no job, computes no match and sends
   * nothing, because no matching engine exists in this project.
   */
  @Post('users/me/saved-searches')
  @HttpCode(201)
  async createSavedSearch(
    @Body(new ZodValidationPipe(SavedSearchInputSchema)) body: SavedSearchInput,
    @Req() request: AccountRequestContext,
  ): Promise<SavedSearchCreatedResponse> {
    const userId = await this.caller(request);
    return await this.account.createSavedSearch({ userId, body });
  }

  @Patch('users/me/saved-searches/:savedSearchId')
  @HttpCode(200)
  async updateSavedSearch(
    @Param('savedSearchId') savedSearchId: string,
    @Body(new ZodValidationPipe(SavedSearchInputSchema)) body: SavedSearchInput,
    @Req() request: AccountRequestContext,
  ): Promise<SavedSearchMutationResponse> {
    const userId = await this.caller(request);
    return await this.account.updateSavedSearch({
      userId,
      id: this.identifier(savedSearchId, 'savedSearchId'),
      body,
    });
  }

  @Delete('users/me/saved-searches/:savedSearchId')
  @HttpCode(200)
  async deleteSavedSearch(
    @Param('savedSearchId') savedSearchId: string,
    @Req() request: AccountRequestContext,
  ): Promise<SavedSearchMutationResponse> {
    const userId = await this.caller(request);
    return await this.account.deleteSavedSearch({
      userId,
      id: this.identifier(savedSearchId, 'savedSearchId'),
    });
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Addresses                                                                                       */
  /* ---------------------------------------------------------------------------------------------- */

  @Get('users/me/addresses')
  async addresses(@Req() request: AccountRequestContext): Promise<AddressesResponse> {
    const userId = await this.caller(request);
    const result = await this.account.addresses(userId);
    return { items: [...result.items] };
  }

  @Post('users/me/addresses')
  @HttpCode(201)
  async createAddress(
    @Body(new ZodValidationPipe(AddressInputSchema)) body: AddressInput,
    @Req() request: AccountRequestContext,
  ): Promise<AddressCreatedResponse> {
    const userId = await this.caller(request);
    return await this.account.createAddress({ userId, body });
  }

  @Patch('users/me/addresses/:addressId')
  @HttpCode(200)
  async updateAddress(
    @Param('addressId') addressId: string,
    @Body(new ZodValidationPipe(AddressInputSchema)) body: AddressInput,
    @Req() request: AccountRequestContext,
  ): Promise<AddressMutationResponse> {
    const userId = await this.caller(request);
    return await this.account.updateAddress({
      userId,
      id: this.identifier(addressId, 'addressId'),
      body,
    });
  }

  @Delete('users/me/addresses/:addressId')
  @HttpCode(200)
  async deleteAddress(
    @Param('addressId') addressId: string,
    @Req() request: AccountRequestContext,
  ): Promise<AddressMutationResponse> {
    const userId = await this.caller(request);
    return await this.account.deleteAddress({
      userId,
      id: this.identifier(addressId, 'addressId'),
    });
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Profile                                                                                         */
  /* ---------------------------------------------------------------------------------------------- */

  @Get('users/me/profile')
  async profile(@Req() request: AccountRequestContext): Promise<BuyerProfileResponse> {
    const userId = await this.caller(request);
    return await this.account.profile(userId);
  }

  /**
   * Edits the four fields a person owns.
   *
   * The schema admits nothing else, so there is no request shape from which a phone number, a
   * verification timestamp, an account status or a role could be sent.
   */
  @Patch('users/me/profile')
  @HttpCode(200)
  async updateProfile(
    @Body(new ZodValidationPipe(UpdateBuyerProfileRequestSchema)) body: UpdateBuyerProfileRequest,
    @Req() request: AccountRequestContext,
  ): Promise<BuyerProfileMutationResponse> {
    const userId = await this.caller(request);
    return await this.account.updateProfile({ userId, body });
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Settings                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  @Get('users/me/settings')
  async settings(@Req() request: AccountRequestContext): Promise<BuyerSettingsResponse> {
    const userId = await this.caller(request);
    return await this.account.settings(userId);
  }

  /** A whole-state write. Writing the same values again is a success that changes nothing. */
  @Put('users/me/settings')
  @HttpCode(200)
  async updateSettings(
    @Body(new ZodValidationPipe(UpdateBuyerSettingsRequestSchema)) body: UpdateBuyerSettingsRequest,
    @Req() request: AccountRequestContext,
  ): Promise<BuyerSettingsMutationResponse> {
    const userId = await this.caller(request);
    return await this.account.updateSettings({ userId, body });
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Reference                                                                                       */
  /* ---------------------------------------------------------------------------------------------- */

  /** Public reference data, behind the session like everything else on this surface. */
  @Get('reference/countries')
  async countries(@Req() request: AccountRequestContext): Promise<CountriesResponse> {
    await this.caller(request);
    const result = await this.account.countries();
    return { items: [...result.items] };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Plumbing                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's account, from their own token. The one place this controller learns who is asking. */
  private async caller(request: AccountRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }

  private limit(value: string | undefined): number {
    const parsed = parseMessagingLimit(value, {
      fallback: ACCOUNT_DEFAULT_LIMIT,
      maximum: ACCOUNT_MAX_LIMIT,
    });
    if (!parsed.ok) throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    return parsed.limit;
  }

  /**
   * A path parameter that names a row.
   *
   * Checked for shape here so a malformed identifier is a validation failure rather than a database
   * error, and so nothing that is not an identifier ever reaches a parameter binding.
   */
  private identifier(value: string, path: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path, message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }
}
