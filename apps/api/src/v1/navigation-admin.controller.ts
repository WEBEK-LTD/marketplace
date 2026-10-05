import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  CreateNavigationItemRequestSchema,
  CreateNavigationMenuRequestSchema,
  NavigationStateRequestSchema,
  ReorderNavigationItemsRequestSchema,
  SESSION_TOKEN_HEADER,
  UpdateNavigationItemRequestSchema,
  UpdateNavigationMenuRequestSchema,
  publicLocaleOf,
  type CreateNavigationItemRequest,
  type CreateNavigationItemResponse,
  type CreateNavigationMenuRequest,
  type CreateNavigationMenuResponse,
  type NavigationMenuDetailResponse,
  type NavigationMenusResponse,
  type NavigationStateRequest,
  type NavigationWriteResponse,
  type ReorderNavigationItemsRequest,
  type UpdateNavigationItemRequest,
  type UpdateNavigationMenuRequest,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { NavigationAdminService } from '../admin/navigation.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface NavigationRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: NavigationRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Arranging the navigation (0094).
 *
 * **Two keys, and the split between them is the shape of this controller.** Every `@Get` needs
 * `cms.navigation.read`; every write needs `cms.navigation.manage`. Both are seeded by 0033 and held by Admin and
 * Super Admin only, and both roles require MFA, so a staff session at `aal1` reaches nothing here.
 *
 * **Showing a menu or an item has its own route, and that is deliberate.** A `PATCH` changes labels, targets and
 * positions and *cannot* change visibility; `PUT …/state` is the only way to put something in front of the public.
 * A single endpoint accepting both would mean a console that meant to fix a typo could publish a half-built menu
 * by sending one extra field.
 *
 * **`items/reorder` is declared before the parameter routes** because Nest matches in declaration order and
 * `:menuId` would otherwise shadow it. The item routes live under their own `items` segment for the same reason.
 *
 * **The controller decides nothing.** The key format, the label lengths, the four target kinds, that exactly the
 * matching column is filled, that a path is relative and the two-level depth are the database's; that a target is
 * one coherent thing is the contract's, checked by the pipe before this code runs.
 */
@Controller('v1/admin/navigation')
export class NavigationAdminController {
  constructor(private readonly navigation: NavigationAdminService) {}

  /** Every menu, served ones first. */
  @Get('menus')
  async list(@Req() request: NavigationRequestContext): Promise<NavigationMenusResponse> {
    return await this.navigation.list({ accessToken: this.token(request) });
  }

  /** Sets the order of the items named, inside one menu, in one request. */
  @Put('items/reorder')
  async reorder(
    @Req() request: NavigationRequestContext,
    @Body(new ZodValidationPipe(ReorderNavigationItemsRequestSchema)) body: ReorderNavigationItemsRequest,
  ): Promise<NavigationWriteResponse> {
    await this.navigation.reorder({
      accessToken: this.token(request),
      menuId: this.identifier(body.menuId, 'menuId'),
      itemIds: body.itemIds.map((id) => this.identifier(id, 'itemIds')),
    });
    return { ok: true };
  }

  /** Creates an item. */
  @Post('items')
  @HttpCode(201)
  async createItem(
    @Req() request: NavigationRequestContext,
    @Body(new ZodValidationPipe(CreateNavigationItemRequestSchema)) body: CreateNavigationItemRequest,
  ): Promise<CreateNavigationItemResponse> {
    const id = await this.navigation.createItem({
      accessToken: this.token(request),
      menuId: this.identifier(body.menuId, 'menuId'),
      labelEn: body.labelEn,
      labelAr: body.labelAr ?? null,
      target: body.target,
      parentId: body.parentId === undefined ? null : this.identifier(body.parentId, 'parentId'),
      opensInNewTab: body.opensInNewTab ?? null,
      sortOrder: body.sortOrder ?? null,
    });
    return { id };
  }

  /**
   * Changes an item.
   *
   * An absent field changes nothing, which is why every argument below distinguishes "absent" from null: for an
   * Arabic label, absent means leave it and null means clear it, and collapsing the two would make one impossible
   * to remove. An absent `target` leaves the target entirely alone.
   */
  @Patch('items/:itemId')
  async updateItem(
    @Req() request: NavigationRequestContext,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(UpdateNavigationItemRequestSchema)) body: UpdateNavigationItemRequest,
  ): Promise<NavigationWriteResponse> {
    await this.navigation.updateItem({
      accessToken: this.token(request),
      itemId: this.identifier(itemId, 'itemId'),
      labelEn: body.labelEn ?? null,
      // A label sent as null clears it; the database reads an empty string as a clear and null as "unchanged",
      // so the two are translated here rather than two layers down.
      labelAr: 'labelAr' in body ? (body.labelAr ?? '') : null,
      target: body.target ?? null,
      parentId: body.parentId === undefined ? null : this.identifier(body.parentId, 'parentId'),
      opensInNewTab: body.opensInNewTab ?? null,
      sortOrder: body.sortOrder ?? null,
    });
    return { ok: true };
  }

  /** Moves one second-level item to the top level of its own menu. */
  @Put('items/:itemId/promote')
  async promoteItem(
    @Req() request: NavigationRequestContext,
    @Param('itemId') itemId: string,
  ): Promise<NavigationWriteResponse> {
    await this.navigation.promoteItem({
      accessToken: this.token(request),
      itemId: this.identifier(itemId, 'itemId'),
    });
    return { ok: true };
  }

  /** Shows or hides one item. */
  @Put('items/:itemId/state')
  async setItemState(
    @Req() request: NavigationRequestContext,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(NavigationStateRequestSchema)) body: NavigationStateRequest,
  ): Promise<NavigationWriteResponse> {
    await this.navigation.setItemState({
      accessToken: this.token(request),
      itemId: this.identifier(itemId, 'itemId'),
      isActive: body.isActive,
    });
    return { ok: true };
  }

  /** Removes one item, and anything under it. */
  @Delete('items/:itemId')
  async removeItem(
    @Req() request: NavigationRequestContext,
    @Param('itemId') itemId: string,
  ): Promise<NavigationWriteResponse> {
    await this.navigation.removeItem({
      accessToken: this.token(request),
      itemId: this.identifier(itemId, 'itemId'),
    });
    return { ok: true };
  }

  /** Creates a menu. */
  @Post('menus')
  @HttpCode(201)
  async createMenu(
    @Req() request: NavigationRequestContext,
    @Body(new ZodValidationPipe(CreateNavigationMenuRequestSchema)) body: CreateNavigationMenuRequest,
  ): Promise<CreateNavigationMenuResponse> {
    const id = await this.navigation.createMenu({
      accessToken: this.token(request),
      menuKey: body.menuKey,
      labelEn: body.labelEn,
      labelAr: body.labelAr ?? null,
    });
    return { id };
  }

  /** One menu with every item it holds, including the ones the public is not being shown. */
  @Get('menus/:menuId')
  async detail(
    @Req() request: NavigationRequestContext,
    @Param('menuId') menuId: string,
    @Query('locale') locale?: string,
  ): Promise<NavigationMenuDetailResponse> {
    const menu = await this.navigation.detail({
      accessToken: this.token(request),
      menuId: this.identifier(menuId, 'menuId'),
      // The locale decides which title of a *target* the console shows, never which items exist.
      locale: publicLocaleOf(locale),
    });
    return { menu };
  }

  /** Changes a menu. */
  @Patch('menus/:menuId')
  async updateMenu(
    @Req() request: NavigationRequestContext,
    @Param('menuId') menuId: string,
    @Body(new ZodValidationPipe(UpdateNavigationMenuRequestSchema)) body: UpdateNavigationMenuRequest,
  ): Promise<NavigationWriteResponse> {
    await this.navigation.updateMenu({
      accessToken: this.token(request),
      menuId: this.identifier(menuId, 'menuId'),
      menuKey: body.menuKey ?? null,
      labelEn: body.labelEn ?? null,
      labelAr: 'labelAr' in body ? (body.labelAr ?? '') : null,
    });
    return { ok: true };
  }

  /** Shows or hides one menu. The only route that can take a whole menu off every public surface. */
  @Put('menus/:menuId/state')
  async setMenuState(
    @Req() request: NavigationRequestContext,
    @Param('menuId') menuId: string,
    @Body(new ZodValidationPipe(NavigationStateRequestSchema)) body: NavigationStateRequest,
  ): Promise<NavigationWriteResponse> {
    await this.navigation.setMenuState({
      accessToken: this.token(request),
      menuId: this.identifier(menuId, 'menuId'),
      isActive: body.isActive,
    });
    return { ok: true };
  }

  /** Removes one menu, and its items with it. */
  @Delete('menus/:menuId')
  async removeMenu(
    @Req() request: NavigationRequestContext,
    @Param('menuId') menuId: string,
  ): Promise<NavigationWriteResponse> {
    await this.navigation.removeMenu({
      accessToken: this.token(request),
      menuId: this.identifier(menuId, 'menuId'),
    });
    return { ok: true };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: NavigationRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private identifier(value: string, path: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path, message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }
}
