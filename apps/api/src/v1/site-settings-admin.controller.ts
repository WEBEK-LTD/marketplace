import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import {
  SESSION_TOKEN_HEADER,
  SITE_SETTINGS_CATEGORY_PATTERN,
  SITE_SETTINGS_KEY_PATTERN,
  SaveSiteSettingRequestSchema,
  type SaveSiteSettingRequest,
  type SiteSettingsResponse,
  type SiteSettingsWriteResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { SiteSettingsAdminService } from '../admin/site-settings.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface SiteSettingsRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: SiteSettingsRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * Editing the platform's own settings (0113).
 *
 * **One key gates every route here**, read and write alike: `settings.site.manage`, seeded by 0033. There is no
 * `settings.site.read` — 0033 seeds none and none is invented — which is why there is no read-only shape of
 * this surface.
 *
 * **A category is the collection and a setting is the resource**, and there are exactly two verbs. There is no
 * `POST` and no `DELETE`, because a setting cannot be created or removed from here: its key, its category, its
 * declared type and its `is_public` flag are decided in a migration where they can be reviewed. The database's
 * own writer refuses an unknown key independently of this file, so that is a property of the system rather
 * than a convention of the controller.
 *
 * **The category is in the address of the write as well as the read**, and that is not decoration. A key's
 * first segment is usually its category and is not always — 0033 seeds `offers.default_expiry_hours` under
 * `marketplace` — so a service that guessed would misreport a refused value as a missing setting.
 *
 * **The controller decides nothing.** Whether a value is of the right type is the writer's test and 0008's
 * constraint; whether a setting exists is the database's answer. The one thing this file owns is refusing a
 * category or a key that is not shaped like one, before any read.
 */
@Controller('v1/admin/settings')
export class SiteSettingsAdminController {
  constructor(private readonly settings: SiteSettingsAdminService) {}

  /** One category's settings, in key order. */
  @Get(':category')
  async list(
    @Req() request: SiteSettingsRequestContext,
    @Param('category') category: string,
  ): Promise<SiteSettingsResponse> {
    return await this.settings.list({
      accessToken: this.token(request),
      category: this.category(category),
    });
  }

  /** Writes one setting's value. The value is the whole body, because the value is the whole resource. */
  @Put(':category/:key')
  async save(
    @Req() request: SiteSettingsRequestContext,
    @Param('category') category: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(SaveSiteSettingRequestSchema)) body: SaveSiteSettingRequest,
  ): Promise<SiteSettingsWriteResponse> {
    await this.settings.save({
      accessToken: this.token(request),
      category: this.category(category),
      key: this.key(key),
      value: body.value,
    });
    return { ok: true };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: SiteSettingsRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  /** 0008's own category format, so an address that is not a category is a 400 and never a round trip. */
  private category(value: string): string {
    if (typeof value !== 'string' || !SITE_SETTINGS_CATEGORY_PATTERN.test(value)) {
      throw new RequestValidationException([{ path: 'category', message: 'The category is invalid.' }]);
    }
    return value;
  }

  /** 0008's own key format. Whether a setting by that key exists is the database's answer, not this one. */
  private key(value: string): string {
    if (typeof value !== 'string' || !SITE_SETTINGS_KEY_PATTERN.test(value)) {
      throw new RequestValidationException([{ path: 'key', message: 'The setting key is invalid.' }]);
    }
    return value;
  }
}
