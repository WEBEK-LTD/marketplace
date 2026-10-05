import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import {
  CreateTagRequestSchema,
  SESSION_TOKEN_HEADER,
  UpdateTagRequestSchema,
  VocabularyStateRequestSchema,
  type AdminTagsResponse,
  type CreateTagResponse,
  type VocabularyWriteResponse,
} from '@repo/contracts';
import { AttributesAdminService } from '../admin/attributes.service.js';
import { identifier, parse, token } from './admin-request.js';

/**
 * `/v1/admin/tags` — the tag vocabulary for the console.
 *
 * Four routes: the tags, create, rename, show/hide. Every one requires the internal BFF credential and a staff
 * session holding `catalog.tag.manage` — its **own** key, separate from the attribute vocabulary's, so holding one
 * grants nothing on the other. The key belongs to roles that require MFA, so a session at `aal1` reaches nothing.
 *
 * **A tag is created active**, unlike an attribute definition: there is nothing to fill in first, so it is usable
 * the moment it exists.
 *
 * **There is no route that changes a slug and none that deletes a tag.** The slug is the tag's public identity with
 * no history to redirect from, and `listing_tags` holds a restricting foreign key, so hiding is the operation that
 * exists. A hidden tag cannot be chosen and does not appear publicly, while the listings already carrying it keep
 * it, so the decision is reversible.
 */
@Controller('v1/admin/tags')
export class TagsAdminController {
  constructor(private readonly attributes: AttributesAdminService) {}

  @Get()
  async tags(@Headers(SESSION_TOKEN_HEADER) sessionToken?: string): Promise<AdminTagsResponse> {
    const found = await this.attributes.tags(token(sessionToken));
    return { tags: [...found.tags], canManage: found.canManage };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<CreateTagResponse> {
    const request = parse(CreateTagRequestSchema, body);
    const tagId = await this.attributes.createTag(token(sessionToken), {
      slug: request.slug,
      nameEn: request.nameEn,
      nameAr: request.nameAr,
    });
    return { tagId };
  }

  @Patch(':tagId')
  async update(
    @Param('tagId') tagId: string,
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<VocabularyWriteResponse> {
    const request = parse(UpdateTagRequestSchema, body);
    const changed = await this.attributes.updateTag(token(sessionToken), identifier(tagId), {
      nameEn: request.nameEn,
      nameAr: request.nameAr,
    });
    return { changed };
  }

  @Put(':tagId/state')
  async state(
    @Param('tagId') tagId: string,
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<VocabularyWriteResponse> {
    const request = parse(VocabularyStateRequestSchema, body);
    const changed = await this.attributes.setTagState(token(sessionToken), identifier(tagId), request.isActive);
    return { changed };
  }
}
