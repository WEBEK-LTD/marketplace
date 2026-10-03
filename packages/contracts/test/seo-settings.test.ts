import { describe, expect, it } from 'vitest';
import {
  SEO_DEFAULT_META_DESCRIPTION_MAX,
  SEO_DEFAULT_META_TITLE_MAX,
  SEO_ROBOTS_BODY_MAX,
  SEO_SETTINGS_LOCALE_PATTERN,
  SEO_SITE_NAME_MAX,
  SEO_TWITTER_SITE_PATTERN,
  SaveSeoSettingsRequestSchema,
  SeoSettingsLocaleSchema,
  SeoSettingsResponseSchema,
} from '../src/index.js';

/**
 * The site-wide SEO settings contracts (0096).
 *
 * What is worth proving here:
 *
 *   * **every bound is 0030's**, restated so a bad value is a 400 rather than a 500;
 *   * **"this locale has nothing authored" is expressible**, because the reader returns a row for every active
 *     locale whether or not one exists — that is what makes the first save possible;
 *   * **the two robots bounds are the same number.** The authoring request reuses the public response's own
 *     constant, so an operator cannot save a body longer than the public contract will accept and thereby make
 *     `/robots.txt` answer 503. This is the one cross-file invariant in this increment, and it is asserted rather
 *     than described;
 *   * **a save is a replace**, so every optional field may be sent as null to clear it, and `siteName` is the one
 *     field that cannot be omitted;
 *   * **no state field exists**, so nothing about a save could change which locale is served or whether a row is
 *     marked as authored.
 */

const AUTHORED = {
  localeCode: 'en',
  nameEn: 'English',
  nameNative: 'English',
  isDefaultLocale: true,
  isAuthored: true,
  robotsIsServed: true,
  siteName: 'Egypt Market',
  defaultMetaTitle: 'Buy and sell in Egypt',
  defaultMetaDescription: 'Everything for sale, in one place.',
  defaultShareMediaId: 'ea000000-0000-4000-8000-0000000000a1',
  shareMediaObjectPath: 'cms-media/share/default.png',
  twitterSite: '@egyptmarket',
  robotsTxtBody: 'User-agent: *\nDisallow: /dashboard',
  organizationStructuredData: { name: 'Egypt Market' },
  updatedAt: '2026-05-02T09:00:00.000Z',
} as const;

const UNAUTHORED = {
  localeCode: 'ar',
  nameEn: 'Arabic',
  nameNative: 'العربية',
  isDefaultLocale: false,
  isAuthored: false,
  robotsIsServed: false,
  siteName: null,
  defaultMetaTitle: null,
  defaultMetaDescription: null,
  defaultShareMediaId: null,
  shareMediaObjectPath: null,
  twitterSite: null,
  robotsTxtBody: null,
  organizationStructuredData: null,
  updatedAt: null,
} as const;

describe('one locale as a console reads it', () => {
  it('accepts an authored locale', () => {
    const parsed = SeoSettingsLocaleSchema.parse(AUTHORED);
    expect(parsed.siteName).toBe('Egypt Market');
    expect(parsed.robotsIsServed).toBe(true);
    // Verbatim, because the body is served verbatim.
    expect(parsed.robotsTxtBody).toBe('User-agent: *\nDisallow: /dashboard');
  });

  it('accepts a locale with nothing authored, which is what makes the first save possible', () => {
    const parsed = SeoSettingsLocaleSchema.parse(UNAUTHORED);
    expect(parsed.isAuthored).toBe(false);
    expect(parsed.siteName).toBeNull();
  });

  it('requires the served marking, so a console can never be left to work it out', () => {
    const { robotsIsServed: _omitted, ...withoutMarking } = AUTHORED;
    expect(SeoSettingsLocaleSchema.safeParse(withoutMarking).success).toBe(false);
  });

  it('requires the authored marking too', () => {
    const { isAuthored: _omitted, ...withoutMarking } = AUTHORED;
    expect(SeoSettingsLocaleSchema.safeParse(withoutMarking).success).toBe(false);
  });

  it('refuses a field nobody declared', () => {
    expect(SeoSettingsLocaleSchema.safeParse({ ...AUTHORED, surprise: 'x' }).success).toBe(false);
  });

  it('refuses a structured-data value that is not an object', () => {
    for (const value of [[], 'a string', 7, true]) {
      expect(SeoSettingsLocaleSchema.safeParse({ ...AUTHORED, organizationStructuredData: value }).success).toBe(
        false,
      );
    }
  });

  it('accepts both locales in one response, with the capability reported', () => {
    const parsed = SeoSettingsResponseSchema.parse({ locales: [AUTHORED, UNAUTHORED], canManage: true });
    expect(parsed.locales).toHaveLength(2);
    expect(parsed.canManage).toBe(true);
  });
});

describe('the locale code', () => {
  it('is 0002’s own format, so a regional locale is representable', () => {
    for (const code of ['en', 'ar', 'en-GB', 'pt-BR']) {
      expect(SEO_SETTINGS_LOCALE_PATTERN.test(code), code).toBe(true);
    }
  });

  it('refuses anything that is not one', () => {
    for (const code of ['english', 'e', 'EN', 'en_GB', 'en-gb', '', '../en', 'en/x']) {
      expect(SEO_SETTINGS_LOCALE_PATTERN.test(code), code).toBe(false);
    }
  });
});

describe('a save', () => {
  it('needs only a site name, because every other field is optional', () => {
    expect(SaveSeoSettingsRequestSchema.parse({ siteName: 'Egypt Market' })).toEqual({ siteName: 'Egypt Market' });
  });

  it('refuses a save with no site name, because 0030 declares the column not null', () => {
    expect(SaveSeoSettingsRequestSchema.safeParse({}).success).toBe(false);
    expect(SaveSeoSettingsRequestSchema.safeParse({ defaultMetaTitle: 'A title' }).success).toBe(false);
  });

  it('refuses a blank or whitespace-only site name', () => {
    expect(SaveSeoSettingsRequestSchema.safeParse({ siteName: '' }).success).toBe(false);
    expect(SaveSeoSettingsRequestSchema.safeParse({ siteName: '   ' }).success).toBe(false);
  });

  it('accepts an explicit null for every optional field, which is how one is cleared', () => {
    const parsed = SaveSeoSettingsRequestSchema.parse({
      siteName: 'Egypt Market',
      defaultMetaTitle: null,
      defaultMetaDescription: null,
      defaultShareMediaId: null,
      twitterSite: null,
      robotsTxtBody: null,
      organizationStructuredData: null,
    });
    expect(parsed.robotsTxtBody).toBeNull();
    expect(parsed.organizationStructuredData).toBeNull();
  });

  it('keeps every length bound 0030 owns', () => {
    const ok = (field: string, value: unknown): boolean =>
      SaveSeoSettingsRequestSchema.safeParse({ siteName: 'Egypt Market', [field]: value }).success;

    expect(SaveSeoSettingsRequestSchema.safeParse({ siteName: 'n'.repeat(SEO_SITE_NAME_MAX) }).success).toBe(true);
    expect(SaveSeoSettingsRequestSchema.safeParse({ siteName: 'n'.repeat(SEO_SITE_NAME_MAX + 1) }).success).toBe(
      false,
    );
    expect(ok('defaultMetaTitle', 't'.repeat(SEO_DEFAULT_META_TITLE_MAX))).toBe(true);
    expect(ok('defaultMetaTitle', 't'.repeat(SEO_DEFAULT_META_TITLE_MAX + 1))).toBe(false);
    expect(ok('defaultMetaDescription', 'd'.repeat(SEO_DEFAULT_META_DESCRIPTION_MAX))).toBe(true);
    expect(ok('defaultMetaDescription', 'd'.repeat(SEO_DEFAULT_META_DESCRIPTION_MAX + 1))).toBe(false);
  });

  it('keeps 0030’s handle format, character for character', () => {
    for (const handle of ['@a', '@egyptmarket', '@A_1', `@${'x'.repeat(15)}`]) {
      expect(SEO_TWITTER_SITE_PATTERN.test(handle), handle).toBe(true);
    }
    for (const handle of ['egyptmarket', '@', `@${'x'.repeat(16)}`, '@has-a-dash', '@has a space', '@@twice']) {
      expect(SEO_TWITTER_SITE_PATTERN.test(handle), handle).toBe(false);
      expect(
        SaveSeoSettingsRequestSchema.safeParse({ siteName: 'Egypt Market', twitterSite: handle }).success,
        handle,
      ).toBe(false);
    }
  });

  it('refuses an organization document that is not a JSON object', () => {
    for (const value of [[], 'a string', 7, true]) {
      expect(
        SaveSeoSettingsRequestSchema.safeParse({ siteName: 'Egypt Market', organizationStructuredData: value })
          .success,
        JSON.stringify(value),
      ).toBe(false);
    }
    expect(
      SaveSeoSettingsRequestSchema.safeParse({ siteName: 'Egypt Market', organizationStructuredData: {} }).success,
    ).toBe(true);
  });

  it('carries a robots body with interior newlines untouched', () => {
    const body = 'User-agent: *\nDisallow: /dashboard\n\nUser-agent: BadBot\nDisallow: /';
    expect(SaveSeoSettingsRequestSchema.parse({ siteName: 'Egypt Market', robotsTxtBody: body }).robotsTxtBody).toBe(
      body,
    );
  });

  it('bounds the robots body at exactly the length the public response accepts', () => {
    // The one cross-file invariant of this increment. A longer body than the public contract accepts would let an
    // operator save a crawl policy that made /robots.txt fail validation and answer 503 — taking the robots document
    // offline by writing one. Asserted here so the two bounds cannot drift apart.
    const atLimit = 'a'.repeat(SEO_ROBOTS_BODY_MAX);
    expect(
      SaveSeoSettingsRequestSchema.safeParse({ siteName: 'Egypt Market', robotsTxtBody: atLimit }).success,
    ).toBe(true);
    expect(
      SaveSeoSettingsRequestSchema.safeParse({ siteName: 'Egypt Market', robotsTxtBody: `${atLimit}a` }).success,
    ).toBe(false);
  });

  it('refuses a share image that is not an identifier', () => {
    expect(
      SaveSeoSettingsRequestSchema.safeParse({ siteName: 'Egypt Market', defaultShareMediaId: 'not-a-uuid' })
        .success,
    ).toBe(false);
  });

  it('has no field that could change state, a locale or an attribution', () => {
    // Nothing in a save can change which locale is served, mark a row as authored, or claim an actor.
    for (const field of [
      'localeCode',
      'isDefaultLocale',
      'robotsIsServed',
      'isAuthored',
      'updatedBy',
      'updatedAt',
    ]) {
      expect(
        SaveSeoSettingsRequestSchema.safeParse({ siteName: 'Egypt Market', [field]: 'en' }).success,
        field,
      ).toBe(false);
    }
  });
});
