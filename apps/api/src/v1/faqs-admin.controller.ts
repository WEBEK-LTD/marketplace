import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  CreateFaqRequestSchema,
  FAQ_MAX_LIMIT,
  FaqStateRequestSchema,
  FaqTopicSchema,
  ReorderFaqsRequestSchema,
  SESSION_TOKEN_HEADER,
  UpdateFaqRequestSchema,
  type CreateFaqRequest,
  type CreateFaqResponse,
  type FaqDetailResponse,
  type FaqPageResponse,
  type FaqStateRequest,
  type FaqTopicsResponse,
  type FaqWriteResponse,
  type ReorderFaqsRequest,
  type UpdateFaqRequest,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { FaqsAdminService } from '../admin/faqs.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface FaqRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: FaqRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authoring the help centre (0095).
 *
 * **Two keys, and the split between them is the shape of this controller.** Every `@Get` needs `cms.faq.read`;
 * every write needs `cms.faq.manage`. Both are seeded by 0033 and held by Admin and Super Admin only, and both
 * roles require MFA, so a staff session at `aal1` reaches nothing here.
 *
 * **Publishing has its own route, and that is deliberate.** `PATCH /:faqId` changes a topic, a question, an answer
 * and a position and *cannot* change whether the entry is published; `PUT /:faqId/state` is the only way to put one
 * on a public page. A single endpoint accepting both would mean a console that meant to fix a typo could publish a
 * half-written answer by sending one extra field.
 *
 * **`topics` and `reorder` are declared before `:faqId`** because Nest matches in declaration order and the
 * parameter route would otherwise shadow them.
 *
 * **The controller decides nothing.** The topic format, the question lengths and that an answer is not empty are
 * the database's; which address shows a topic is `pages.page_key`, reported by the reader.
 */
@Controller('v1/admin/faqs')
export class FaqsAdminController {
  constructor(private readonly faqs: FaqsAdminService) {}

  /** Every topic in use, with how much of each is published and whether a public page shows it. */
  @Get('topics')
  async topics(@Req() request: FaqRequestContext): Promise<FaqTopicsResponse> {
    return await this.faqs.topics({ accessToken: this.token(request) });
  }

  /** Sets the order of the entries named, inside one topic, in one request. */
  @Put('reorder')
  async reorder(
    @Req() request: FaqRequestContext,
    @Body(new ZodValidationPipe(ReorderFaqsRequestSchema)) body: ReorderFaqsRequest,
  ): Promise<FaqWriteResponse> {
    await this.faqs.reorder({
      accessToken: this.token(request),
      topic: body.topic,
      faqIds: body.faqIds.map((id) => this.identifier(id, 'faqIds')),
    });
    return { ok: true };
  }

  /** One page of entries, in help-centre order. */
  @Get()
  async list(
    @Req() request: FaqRequestContext,
    @Query('topic') topic?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<FaqPageResponse> {
    return await this.faqs.list({
      accessToken: this.token(request),
      topic: this.topicFilter(topic),
      cursor: typeof cursor === 'string' && cursor !== '' ? cursor : null,
      limit: this.limit(limit),
    });
  }

  /** One entry. */
  @Get(':faqId')
  async detail(
    @Req() request: FaqRequestContext,
    @Param('faqId') faqId: string,
  ): Promise<FaqDetailResponse> {
    const faq = await this.faqs.detail({
      accessToken: this.token(request),
      faqId: this.identifier(faqId, 'faqId'),
    });
    return { faq };
  }

  /** Creates an unpublished entry. */
  @Post()
  @HttpCode(201)
  async create(
    @Req() request: FaqRequestContext,
    @Body(new ZodValidationPipe(CreateFaqRequestSchema)) body: CreateFaqRequest,
  ): Promise<CreateFaqResponse> {
    const id = await this.faqs.create({
      accessToken: this.token(request),
      topic: body.topic,
      questionEn: body.questionEn,
      questionAr: body.questionAr ?? null,
      answerEn: body.answerEn,
      answerAr: body.answerAr ?? null,
      sortOrder: body.sortOrder ?? null,
    });
    return { id };
  }

  /**
   * Changes an entry.
   *
   * An absent field changes nothing, which is why every argument below distinguishes "absent" from null: for an
   * Arabic wording, absent means leave it and null means clear it, and collapsing the two would make one
   * impossible to remove.
   */
  @Patch(':faqId')
  async update(
    @Req() request: FaqRequestContext,
    @Param('faqId') faqId: string,
    @Body(new ZodValidationPipe(UpdateFaqRequestSchema)) body: UpdateFaqRequest,
  ): Promise<FaqWriteResponse> {
    await this.faqs.update({
      accessToken: this.token(request),
      faqId: this.identifier(faqId, 'faqId'),
      topic: body.topic ?? null,
      questionEn: body.questionEn ?? null,
      // A wording sent as null clears it; the database reads an empty string as a clear and null as "unchanged",
      // so the two are translated here rather than two layers down.
      questionAr: 'questionAr' in body ? (body.questionAr ?? '') : null,
      answerEn: body.answerEn ?? null,
      answerAr: 'answerAr' in body ? (body.answerAr ?? '') : null,
      sortOrder: body.sortOrder ?? null,
    });
    return { ok: true };
  }

  /** Publishes or unpublishes one entry. The only route that can put one on a public page. */
  @Put(':faqId/state')
  async setState(
    @Req() request: FaqRequestContext,
    @Param('faqId') faqId: string,
    @Body(new ZodValidationPipe(FaqStateRequestSchema)) body: FaqStateRequest,
  ): Promise<FaqWriteResponse> {
    await this.faqs.setState({
      accessToken: this.token(request),
      faqId: this.identifier(faqId, 'faqId'),
      isPublished: body.isPublished,
    });
    return { ok: true };
  }

  /** Removes one entry. */
  @Delete(':faqId')
  async remove(
    @Req() request: FaqRequestContext,
    @Param('faqId') faqId: string,
  ): Promise<FaqWriteResponse> {
    await this.faqs.remove({
      accessToken: this.token(request),
      faqId: this.identifier(faqId, 'faqId'),
    });
    return { ok: true };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: FaqRequestContext): string {
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

  /** A filter is optional, and one that could not be a topic is a 400 rather than a silent full list. */
  private topicFilter(topic: string | undefined): string | null {
    if (typeof topic !== 'string' || topic === '') return null;
    const parsed = FaqTopicSchema.safeParse(topic);
    if (!parsed.success) {
      throw new RequestValidationException([{ path: 'topic', message: 'The topic is invalid.' }]);
    }
    return parsed.data;
  }

  private limit(limit: string | undefined): number | null {
    if (typeof limit !== 'string' || limit === '') return null;
    if (!/^[1-9][0-9]{0,3}$/.test(limit)) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    const value = Number(limit);
    if (value > FAQ_MAX_LIMIT) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return value;
  }
}
