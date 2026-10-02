import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import {
  CreateAttributeDefinitionRequestSchema,
  CreateAttributeOptionRequestSchema,
  SESSION_TOKEN_HEADER,
  UpdateAttributeDefinitionRequestSchema,
  UpdateAttributeOptionRequestSchema,
  VocabularyStateRequestSchema,
  type AdminAttributeDefinitionsResponse,
  type AdminAttributeDetailResponse,
  type CreateAttributeDefinitionResponse,
  type CreateAttributeOptionResponse,
  type VocabularyWriteResponse,
} from '@repo/contracts';
import { AttributesAdminService } from '../admin/attributes.service.js';
import { identifier, parse, token } from './admin-request.js';

/**
 * `/v1/admin/attributes` — the structured attribute vocabulary for the console.
 *
 * Eight routes: the vocabulary, one attribute with its options, create, edit, show/hide, add an option, edit one,
 * show/hide one. Every one requires the internal BFF credential — the guard covers all of `/v1` by construction —
 * and a staff session holding `catalog.attribute.manage`, which belongs to roles that require MFA, so a session at
 * `aal1` reaches nothing. No read key was invented: the people who maintain the vocabulary are the people who may
 * see it.
 *
 * **The controller decides nothing.** The shape of an attribute is migrations 0010 and 0011's, the permission test
 * is 0088's, and the refusals are SQLSTATEs translated by the service. What happens here is parsing: a body is
 * rebuilt from the contract rather than forwarded, and a parameter that cannot name anything is refused before it
 * reaches a store.
 *
 * **There is no route that renames a key, retypes an attribute, changes an option's value or deletes anything.**
 * The first three are machine identity that stored answers refer to; deletion is restricted by foreign keys from
 * `category_attributes` and from listings' own answers, so hiding is the operation that exists. None of these is a
 * route this file declines to offer — none exists.
 *
 * **Which categories ask for an attribute is not decided here.** That is `catalog.category.manage`'s, on the
 * category's own surface, because it is what `category_attributes`' write policy names.
 */
@Controller('v1/admin/attributes')
export class AttributesAdminController {
  constructor(private readonly attributes: AttributesAdminService) {}

  @Get()
  async definitions(
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<AdminAttributeDefinitionsResponse> {
    const found = await this.attributes.definitions(token(sessionToken));
    return { attributes: [...found.attributes], canManage: found.canManage };
  }

  @Get(':definitionId')
  async definition(
    @Param('definitionId') definitionId: string,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<AdminAttributeDetailResponse> {
    const found = await this.attributes.definition(token(sessionToken), identifier(definitionId));
    return { attribute: found.attribute, options: [...found.options], canManage: found.canManage };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<CreateAttributeDefinitionResponse> {
    const request = parse(CreateAttributeDefinitionRequestSchema, body);
    const definitionId = await this.attributes.createDefinition(token(sessionToken), {
      key: request.key,
      dataType: request.dataType,
      nameEn: request.nameEn,
      nameAr: request.nameAr,
      unit: request.unit ?? null,
      isFilterable: request.isFilterable ?? true,
      sortOrder: request.sortOrder ?? 0,
    });
    return { definitionId };
  }

  @Patch(':definitionId')
  async update(
    @Param('definitionId') definitionId: string,
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<VocabularyWriteResponse> {
    const request = parse(UpdateAttributeDefinitionRequestSchema, body);
    const changed = await this.attributes.updateDefinition(token(sessionToken), identifier(definitionId), {
      nameEn: request.nameEn,
      nameAr: request.nameAr,
      // A blank unit clears it; the writer stores a blank as null, so no field renders as an empty measurement.
      unit: blank(request.unit),
      isFilterable: request.isFilterable,
      sortOrder: request.sortOrder,
    });
    return { changed };
  }

  @Put(':definitionId/state')
  async state(
    @Param('definitionId') definitionId: string,
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<VocabularyWriteResponse> {
    const request = parse(VocabularyStateRequestSchema, body);
    const changed = await this.attributes.setDefinitionState(
      token(sessionToken),
      identifier(definitionId),
      request.isActive,
    );
    return { changed };
  }

  @Post(':definitionId/options')
  @HttpCode(201)
  async createOption(
    @Param('definitionId') definitionId: string,
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<CreateAttributeOptionResponse> {
    const request = parse(CreateAttributeOptionRequestSchema, body);
    const optionId = await this.attributes.createOption(token(sessionToken), identifier(definitionId), {
      value: request.value,
      labelEn: request.labelEn,
      labelAr: request.labelAr,
      sortOrder: request.sortOrder ?? 0,
    });
    return { optionId };
  }

  /**
   * The definition in the path is the address, and the option's own identifier is what the writer takes.
   *
   * An option carries its attribute in its own row, so a mismatched pair cannot write to the wrong attribute: the
   * writer would be editing an option that is what it is regardless of the path it was reached through.
   */
  @Patch(':definitionId/options/:optionId')
  async updateOption(
    @Param('definitionId') definitionId: string,
    @Param('optionId') optionId: string,
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<VocabularyWriteResponse> {
    identifier(definitionId);
    const request = parse(UpdateAttributeOptionRequestSchema, body);
    const changed = await this.attributes.updateOption(token(sessionToken), identifier(optionId), {
      labelEn: request.labelEn,
      labelAr: request.labelAr,
      sortOrder: request.sortOrder,
    });
    return { changed };
  }

  @Put(':definitionId/options/:optionId/state')
  async optionState(
    @Param('definitionId') definitionId: string,
    @Param('optionId') optionId: string,
    @Body() body: unknown,
    @Headers(SESSION_TOKEN_HEADER) sessionToken?: string,
  ): Promise<VocabularyWriteResponse> {
    identifier(definitionId);
    const request = parse(VocabularyStateRequestSchema, body);
    const changed = await this.attributes.setOptionState(
      token(sessionToken),
      identifier(optionId),
      request.isActive,
    );
    return { changed };
  }
}

/** A field sent blank is cleared; one left out is cleared too, because this request replaces the row. */
function blank(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
