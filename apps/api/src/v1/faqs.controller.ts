import { Controller, Get, Query } from '@nestjs/common';
import { FaqTopicSchema, publicLocaleOf, type PublicFaqsResponse } from '@repo/contracts';
import { FaqsPublicService } from '../cms/faqs-public.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';

/**
 * `GET /v1/faqs` — the published help-centre entries of one topic (0095).
 *
 * One read, no user context, no body, no pagination: a help page shows the questions somebody arranged, not a
 * paged list.
 *
 * **`topic` is required, and it is a page's own `page_key`** (owner decision 1). This route takes the topic rather
 * than an address because the mapping *is* the page's key, and resolving an address to a page is the business of
 * whichever surface is rendering one. A topic that is not a topic is a 400 rather than an empty answer: a caller
 * that sent one has a bug, and answering "nothing published" would hide it.
 *
 * `locale` selects a representation and never a subset: the same entries come back in either language, worded in
 * the one that was asked for, with English as the fallback where no Arabic was written.
 *
 * **An empty `entries` array is a real answer**, not a 404 (owner decision 2): a page whose topic has nothing
 * published renders no FAQ section, and it needs to be able to tell that from a failure.
 */
@Controller('v1')
export class FaqsController {
  constructor(private readonly faqs: FaqsPublicService) {}

  @Get('faqs')
  async entries(
    @Query('topic') topic?: string,
    @Query('locale') locale?: string,
  ): Promise<PublicFaqsResponse> {
    const parsed = FaqTopicSchema.safeParse(topic);
    if (!parsed.success) {
      throw new RequestValidationException([{ path: 'topic', message: 'The topic is invalid.' }]);
    }

    const entries = await this.faqs.entries({ topic: parsed.data, locale: publicLocaleOf(locale) });
    return { topic: parsed.data, entries: [...entries] };
  }
}
