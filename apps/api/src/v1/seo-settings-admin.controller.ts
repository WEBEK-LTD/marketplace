import { Body, Controller, Delete, Get, Param, Put, Req } from '@nestjs/common';
import {
  SESSION_TOKEN_HEADER,
  SEO_SETTINGS_LOCALE_PATTERN,
  SaveSeoSettingsRequestSchema,
  type SaveSeoSettingsRequest,
  type SeoSettingsResponse,
  type SeoSettingsWriteResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { SeoSettingsAdminService } from '../admin/seo-settings.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface SeoSettingsRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: SeoSettingsRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * Maintaining the site-wide SEO defaults (0096).
 *
 * **One key gates every route here**, read and write alike: `seo.settings.manage`, seeded by 0033 and held by Admin
 * and Super Admin only, both of which require MFA, so a staff session at `aal1` reaches nothing. There is no
 * `seo.settings.read` — 0033 seeds none and none is invented — which is owner decision 6, and it is why there is no
 * read-only shape of this surface.
 *
 * **A locale is the resource.** `PUT /{localeCode}` writes one locale's row and creating and replacing are the same
 * request, because one locale has one row and the request *is* that row: an absent field clears the stored value.
 * That is also how an authored crawl policy is withdrawn without deleting the locale. `DELETE /{localeCode}` returns
 * the locale to unauthored, which for the default locale returns `/robots.txt` to the minimal document the public
 * web already serves when nothing has been authored.
 *
 * **The controller decides nothing.** Every length, format and shape is the database's, restated by the contract so
 * a bad value is a 400 rather than a 500; whether a locale may be authored is the writer's test against
 * `locales.is_active`; and which locale's robots body is served is computed by the reader. The one thing this file
 * owns is refusing a locale code that is not a locale code, before any read.
 *
 * **Nothing here consumes a setting.** No route emits a site name, a metadata default, Twitter metadata or
 * JSON-LD, and none builds an absolute URL or resolves a media object. `/robots.txt` keeps the reader it has had
 * since 0086, untouched by this file.
 */
@Controller('v1/admin/seo/settings')
export class SeoSettingsAdminController {
  constructor(private readonly settings: SeoSettingsAdminService) {}

  /** Every active locale, default locale first, authored or not. */
  @Get()
  async list(@Req() request: SeoSettingsRequestContext): Promise<SeoSettingsResponse> {
    return await this.settings.list({ accessToken: this.token(request) });
  }

  /**
   * Writes one locale's settings.
   *
   * Every optional field is sent to the writer as `null` when it is absent, because a save is a replace: the form
   * is the row. That is not the homepage's "absent means unchanged" shape, and the difference is deliberate — these
   * are seven fields of one settings document rather than a row with independent parts.
   */
  @Put(':localeCode')
  async save(
    @Req() request: SeoSettingsRequestContext,
    @Param('localeCode') localeCode: string,
    @Body(new ZodValidationPipe(SaveSeoSettingsRequestSchema)) body: SaveSeoSettingsRequest,
  ): Promise<SeoSettingsWriteResponse> {
    await this.settings.save({
      accessToken: this.token(request),
      localeCode: this.locale(localeCode),
      siteName: body.siteName,
      defaultMetaTitle: body.defaultMetaTitle ?? null,
      defaultMetaDescription: body.defaultMetaDescription ?? null,
      defaultShareMediaId: body.defaultShareMediaId ?? null,
      twitterSite: body.twitterSite ?? null,
      robotsTxtBody: body.robotsTxtBody ?? null,
      organizationStructuredData: body.organizationStructuredData ?? null,
    });
    return { ok: true };
  }

  /** Removes one locale's settings, returning it to unauthored. */
  @Delete(':localeCode')
  async remove(
    @Req() request: SeoSettingsRequestContext,
    @Param('localeCode') localeCode: string,
  ): Promise<SeoSettingsWriteResponse> {
    await this.settings.remove({
      accessToken: this.token(request),
      localeCode: this.locale(localeCode),
    });
    return { ok: true };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: SeoSettingsRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  /**
   * 0002's own locale format, so an address that is not a locale is a 400 and never a database round trip.
   *
   * Whether the locale *exists and is active* is the writer's answer, not this one: that is a question about the
   * platform's state and belongs where the state is.
   */
  private locale(value: string): string {
    if (typeof value !== 'string' || !SEO_SETTINGS_LOCALE_PATTERN.test(value)) {
      throw new RequestValidationException([{ path: 'localeCode', message: 'The locale is invalid.' }]);
    }
    return value;
  }
}
