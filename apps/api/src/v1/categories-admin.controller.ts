import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  CategoryStateRequestSchema,
  CreateCategoryRequestSchema,
  SaveCategoryTranslationRequestSchema,
  SESSION_TOKEN_HEADER,
  UpdateCategoryRequestSchema,
  type AdminCategoryDetailResponse,
  type AdminCategoryTreeResponse,
  type CategoryWriteResponse,
  type CreateCategoryResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { CategoriesAdminService } from '../admin/categories.service.js';

/**
 * `/v1/admin/categories` — the category tree for the console.
 *
 * Seven routes: the tree, one category, create, edit, show/hide, and write or remove one locale. Every one
 * requires the internal BFF credential — the guard covers all of `/v1` by construction — and a staff session
 * holding `catalog.category.read`, with `catalog.category.manage` for the writes. Both keys belong to roles that
 * require MFA, so a session at `aal1` reaches nothing.
 *
 * **The controller decides nothing.** The shape of the tree is migration 0010's, the permission test is 0087's,
 * and the refusals are SQLSTATEs translated by the service. What happens here is parsing: a body is rebuilt from
 * the contract rather than forwarded, and a parameter that cannot name anything is refused before it reaches a
 * store.
 *
 * **There is no route that renames a category and no route that deletes one.** The slug is the category's public
 * address and there is no slug history to redirect from (owner decision); deletion is restricted by foreign keys
 * from listings, commission rules, tax rules, coupons and promotion packages, so hiding is the operation that
 * exists. Neither is a route this file declines to offer — neither exists.
 */
@Controller('v1/admin/categories')
export class CategoriesAdminController {
  constructor(private readonly categories: CategoriesAdminService) {}

  @Get()
  async tree(@Headers(SESSION_TOKEN_HEADER) sessionToken?: string): Promise<AdminCategoryTreeResponse> {
    const categories = await this.categories.tree(token(sessionToken));
    return { categories: [...categories] };
  }

  @Get(':categoryId')
  async detail(
    @Param('categoryId') categoryId: string,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<AdminCategoryDetailResponse> {
    const found = await this.categories.detail(token(sessionToken), identifier(categoryId));
    return { category: found.category, translations: [...found.translations] };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<CreateCategoryResponse> {
    const request = parse(CreateCategoryRequestSchema, body);
    const categoryId = await this.categories.create(token(sessionToken), {
      slug: request.slug,
      parentId: request.parentId ?? null,
      listingTypeCode: request.listingTypeCode ?? null,
      sortOrder: request.sortOrder ?? 0,
    });
    return { categoryId };
  }

  @Patch(':categoryId')
  async update(
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<CategoryWriteResponse> {
    const request = parse(UpdateCategoryRequestSchema, body);
    const changed = await this.categories.update(token(sessionToken), identifier(categoryId), {
      setParent: request.setParent,
      parentId: request.parentId ?? null,
      listingTypeCode: request.listingTypeCode ?? null,
      sortOrder: request.sortOrder ?? null,
    });
    return { changed };
  }

  @Put(':categoryId/state')
  async state(
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<CategoryWriteResponse> {
    const request = parse(CategoryStateRequestSchema, body);
    const changed = await this.categories.setState(token(sessionToken), identifier(categoryId), request.isActive);
    return { changed };
  }

  @Put(':categoryId/translations/:localeCode')
  async saveTranslation(
    @Param('categoryId') categoryId: string,
    @Param('localeCode') localeCode: string,
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<CategoryWriteResponse> {
    const request = parse(SaveCategoryTranslationRequestSchema, body);
    const changed = await this.categories.saveTranslation(
      token(sessionToken),
      identifier(categoryId),
      locale(localeCode),
      {
        name: request.name,
        // An empty string clears the field; the writer stores a blank as null.
        description: optional(request.description),
        metaTitle: optional(request.metaTitle),
        metaDescription: optional(request.metaDescription),
      },
    );
    return { changed };
  }

  @Delete(':categoryId/translations/:localeCode')
  async removeTranslation(
    @Param('categoryId') categoryId: string,
    @Param('localeCode') localeCode: string,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<CategoryWriteResponse> {
    const changed = await this.categories.removeTranslation(
      token(sessionToken),
      identifier(categoryId),
      locale(localeCode),
    );
    return { changed };
  }
}

/** A session token must be present. Its contents are the provider's to judge, never this file's. */
function token(value: string | undefined): string {
  if (typeof value !== 'string' || value === '') throw new AuthenticationRequiredError();
  return value;
}

/** A uuid, or a 400. A string that cannot be an identifier never reaches a store. */
function identifier(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException();
  }
  return value;
}

/** A seeded locale code's shape. The foreign key is the authority; this keeps a wild string out of a parameter. */
function locale(value: string): string {
  if (!/^[a-z]{2}$/.test(value)) throw new BadRequestException();
  return value;
}

/** A field left out stays out; a field sent blank is cleared. */
function optional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The body is rebuilt from the contract rather than forwarded, so nothing unexpected reaches a writer. */
function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException();
  return result.data;
}
