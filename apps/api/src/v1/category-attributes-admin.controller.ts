import { Body, Controller, Delete, Get, Headers, Param, Put } from '@nestjs/common';
import {
  AttachCategoryAttributeRequestSchema,
  SESSION_TOKEN_HEADER,
  type AdminCategoryAttributesResponse,
  type VocabularyWriteResponse,
} from '@repo/contracts';
import { AttributesAdminService } from '../admin/attributes.service.js';
import { identifier, parse, token } from './admin-request.js';

/**
 * `/v1/admin/categories/{categoryId}/attributes` — which attributes a category asks its sellers about.
 *
 * Three routes: read, attach-or-edit, detach. Its own controller rather than more routes on 0087's, because this
 * is a different thing being managed through the same address, and 0087's surface is approved and complete.
 *
 * **The key is `catalog.category.manage`, not `catalog.attribute.manage`.** That is what `category_attributes`' own
 * write policy names, and the distinction is the point: defining an attribute and deciding which categories ask
 * for it are separate authorities, so somebody who maintains the vocabulary cannot reshape every seller's form.
 * Reading needs `catalog.category.read`, as the rest of the category surface does.
 *
 * **Attaching and editing are one route.** Asking for an attribute the category already asks for is a change to
 * *how* it asks — required or not, filterable or not, in what order — rather than an error; a console that had to
 * know which it was would have to ask first and could still be wrong by the time it wrote.
 *
 * **Detaching keeps the answers.** It is a decision about a form, not about data: the attribute stops being asked
 * and stops being editable, every answer already given stays where it is, and re-attaching brings them all back.
 * No answer is deleted anywhere in this increment.
 *
 * **`isRequired` is advisory** (owner decision): a seller's form marks the field and says so in words, and nothing
 * refuses a save or a submission for want of an answer.
 */
@Controller('v1/admin/categories')
export class CategoryAttributesAdminController {
  constructor(private readonly attributes: AttributesAdminService) {}

  @Get(':categoryId/attributes')
  async attributesOf(
    @Param('categoryId') categoryId: string,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<AdminCategoryAttributesResponse> {
    const found = await this.attributes.categoryAttributes(token(sessionToken), identifier(categoryId));
    return { attributes: [...found.attributes], canManage: found.canManage };
  }

  @Put(':categoryId/attributes')
  async attach(
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<VocabularyWriteResponse> {
    const request = parse(AttachCategoryAttributeRequestSchema, body);
    const changed = await this.attributes.attachCategoryAttribute(token(sessionToken), identifier(categoryId), {
      definitionId: request.definitionId,
      isRequired: request.isRequired ?? false,
      isFilterable: request.isFilterable ?? true,
      sortOrder: request.sortOrder ?? 0,
    });
    return { changed };
  }

  @Delete(':categoryId/attributes/:definitionId')
  async detach(
    @Param('categoryId') categoryId: string,
    @Param('definitionId') definitionId: string,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<VocabularyWriteResponse> {
    const changed = await this.attributes.detachCategoryAttribute(
      token(sessionToken),
      identifier(categoryId),
      identifier(definitionId),
    );
    return { changed };
  }
}
