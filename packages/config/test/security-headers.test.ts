import { describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  cmsPageSlugs,
  indexableExactRoutes,
  createNonce,
  isCmsPageSlug,
  isPublicCatalogRoute,
  parsePublicCategoryPath,
  parsePublicCmsPagePath,
  publicCmsPagePath,
  parsePublicDetailPath,
  parsePublicSellerPath,
  parsePublicListingPath,
  parsePublicServicePath,
  publicCategoryPath,
  publicListingPath,
  publicSellerPath,
  publicServicePath,
  robotsHeaderFor,
  staticSecurityHeaders,
} from '../src/index.js';

describe('CSP', () => {
  it('builds the approved policy around a nonce', () => {
    const nonce = createNonce();
    expect(buildContentSecurityPolicy(nonce)).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
        `style-src 'self' 'nonce-${nonce}'`,
        "img-src 'self' blob: data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        'upgrade-insecure-requests',
      ].join('; '),
    );
  });

  it('never allows unsafe-inline, unsafe-eval or wildcards', () => {
    const csp = buildContentSecurityPolicy(createNonce());
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('creates unpredictable 128-bit nonces', () => {
    const nonces = new Set(Array.from({ length: 1000 }, () => createNonce()));
    expect(nonces.size).toBe(1000);
    for (const nonce of nonces) expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
  });

  it.each(["abc'; script-src *", '', 'short', 'x'.repeat(10) + ' '])('rejects an unsafe nonce %j', (nonce) => {
    expect(() => buildContentSecurityPolicy(nonce)).toThrow(TypeError);
  });
});

describe('static security headers', () => {
  const asMap = (app: 'web' | 'admin') => Object.fromEntries(staticSecurityHeaders(app).map((h) => [h.key, h.value]));

  it('match the approved values for the public web', () => {
    // No X-Robots-Tag: the public web decides it per request, because a blanket header would override
    // the catalogue pages' own robots metadata rather than defer to it.
    expect(asMap('web')).toEqual({
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    expect(asMap('web')['X-Robots-Tag']).toBeUndefined();
  });

  it('use no-referrer and a blanket noindex for the admin app', () => {
    expect(asMap('admin')['Referrer-Policy']).toBe('no-referrer');
    expect(asMap('admin')['X-Robots-Tag']).toBe('noindex');
  });
});

describe('the public catalogue routes', () => {
  it('recognises every approved catalogue route in both languages', () => {
    for (const path of [
      '/categories',
      '/ar/categories',
      '/listings',
      '/ar/listings',
      '/listing/a-chair',
      '/ar/listing/a-chair',
      '/services',
      '/ar/services',
      '/service/logo-design',
      '/ar/service/logo-design',
      '/category/furniture',
      '/ar/category/furniture',
      '/seller/good-shop',
      '/ar/seller/good-shop',
      '/marketplace',
      '/ar/marketplace',
      // A slug may carry digits and hyphens, and a trailing slash is still the same route.
      '/listing/sofa-2-seat',
      '/listings/',
      // The CMS static pages. No blanket header, because the administrator's own `isIndexable` decides.
      '/terms',
      '/ar/terms',
      '/about',
      '/ar/privacy',
      '/intellectual-property',
      '/terms/',
    ]) {
      expect(isPublicCatalogRoute(path), path).toBe(true);
    }
  });

  it('recognises nothing else, so an unlisted route keeps its noindex', () => {
    for (const path of [
      '/',
      '/ar',
      '/login',
      '/ar/login',
      '/forgot-password',
      '/forgot-password/verify',
      '/reset-password',
      '/dashboard',
      '/dashboard/settings',
      '/ar/dashboard/settings',
      '/api/listings',
      '/api/listings/a-chair',
      '/api/auth/login',
      '/nope',
      '/categories-secret',
      '/listingsomething',
      '/servicesomething',
      '/categoryfoo',
      '/category',
      '/category/',
      '/category/furniture/edit',
      '/ar/category/furniture/edit',
      '/category/Furniture',
      '/category/..%2Fdashboard',
      '/sellerfoo',
      '/sellers',
      '/seller',
      '/seller/',
      '/seller/good-shop/edit',
      '/ar/seller/good-shop/edit',
      '/seller/Good-Shop',
      '/seller/..%2Fdashboard',
      // The discovery hub is one exact route: neither a prefix nor a family.
      '/marketplaces',
      '/marketplace/x',
      '/ar/marketplace/x',
      // Routes the specification names but never describes stay denied.
      '/featured',
      '/new',
      '/popular',
      '/deals',
      // `become-a-seller` is a built page of its own, not a CMS page, so the CMS cannot shadow it.
      '/become-a-seller',
      // One segment only, and the exact slug only: neither a prefix nor a family.
      '/terms-and-conditions',
      '/terms/old',
      '/ar/terms/old',
      '/Terms',
      '/sellers',
      '/service',
      '/service/',
      '/service/logo-design/edit',
      '/ar/service/logo-design/edit',
      '/service/Logo-Design',
      // One segment only: an edit screen under a listing is not the listing's public page.
      '/listing/a-chair/edit',
      '/ar/listing/a-chair/edit',
      // Not slug-shaped, so the `/listing/` prefix alone does not earn the exemption.
      '/listing/..%2fdashboard',
      '/listing/../dashboard',
      '/listing/A-Chair',
      '/listing/-chair',
      '/listing/a chair',
      // A locale prefix on its own names no page.
      '/listing/',
      '/listing',
    ]) {
      expect(isPublicCatalogRoute(path), path).toBe(false);
    }
  });

  it('refuses anything that is not a path, rather than treating it as public', () => {
    for (const value of ['', 'categories', 'https://example.com/listings', '//evil.example/listings']) {
      expect(isPublicCatalogRoute(value), value).toBe(false);
    }
  });
});

describe('the listing path parser', () => {
  // One definition of what a listing URL is, read by both the robots policy and the status routing, so
  // the two cannot disagree about which requests are listing pages.
  it('names the listing and the locale', () => {
    expect(parsePublicListingPath('/listing/a-chair')).toEqual({ locale: 'en', slug: 'a-chair' });
    expect(parsePublicListingPath('/ar/listing/a-chair')).toEqual({ locale: 'ar', slug: 'a-chair' });
    expect(parsePublicListingPath('/en/listing/sofa-2-seat')).toEqual({ locale: 'en', slug: 'sofa-2-seat' });
    expect(parsePublicListingPath('/listing/a-chair/')).toEqual({ locale: 'en', slug: 'a-chair' });
  });

  it('refuses anything that is not one listing slug', () => {
    for (const path of [
      '/listings',
      '/listing',
      '/listing/',
      '/categories',
      '/listing/a-chair/edit',
      // Traversal, encoded separators, uppercase and spaces are not slugs, so they are not listing paths.
      '/listing/../dashboard',
      '/listing/..%2Fdashboard',
      '/listing/a-chair%2Fedit',
      '/listing/A-Chair',
      '/listing/-chair',
      '/listing/a chair',
      '/listing/a_chair',
      '',
      'listing/a-chair',
    ]) {
      expect(parsePublicListingPath(path), path).toBeNull();
    }
  });

  it('keeps the category surface out of the listing-detail union', () => {
    // A category is neither a product nor a service, so it must not be a candidate for a cross-surface
    // redirect — but it is still a public catalogue route for the robots policy.
    expect(parsePublicDetailPath('/category/furniture')).toBeNull();
    expect(parsePublicCategoryPath('/category/furniture')).toEqual({ locale: 'en', slug: 'furniture' });
    expect(parsePublicCategoryPath('/ar/category/furniture')).toEqual({ locale: 'ar', slug: 'furniture' });
    expect(parsePublicCategoryPath('/listing/a-chair')).toBeNull();
    expect(parsePublicCategoryPath('/service/logo-design')).toBeNull();
    expect(isPublicCatalogRoute('/category/furniture')).toBe(true);

    for (const locale of ['en', 'ar'] as const) {
      expect(parsePublicCategoryPath(publicCategoryPath(locale, 'furniture'))).toEqual({
        locale,
        slug: 'furniture',
      });
    }
    expect(publicCategoryPath('en', 'furniture')).toBe('/category/furniture');
    expect(publicCategoryPath('ar', 'furniture')).toBe('/ar/category/furniture');
  });

  it('keeps the seller surface out of the listing-detail union', () => {
    // A seller is neither a product nor a service, so it must never be a candidate for a cross-surface
    // redirect — but it is still a public catalogue route for the robots policy.
    expect(parsePublicDetailPath('/seller/good-shop')).toBeNull();
    expect(parsePublicCategoryPath('/seller/good-shop')).toBeNull();
    expect(parsePublicSellerPath('/seller/good-shop')).toEqual({ locale: 'en', slug: 'good-shop' });
    expect(parsePublicSellerPath('/ar/seller/good-shop')).toEqual({ locale: 'ar', slug: 'good-shop' });
    expect(parsePublicSellerPath('/category/furniture')).toBeNull();
    expect(parsePublicSellerPath('/listing/a-chair')).toBeNull();
    expect(isPublicCatalogRoute('/seller/good-shop')).toBe(true);

    for (const locale of ['en', 'ar'] as const) {
      expect(parsePublicSellerPath(publicSellerPath(locale, 'good-shop'))).toEqual({
        locale,
        slug: 'good-shop',
      });
    }
    expect(publicSellerPath('en', 'good-shop')).toBe('/seller/good-shop');
    expect(publicSellerPath('ar', 'good-shop')).toBe('/ar/seller/good-shop');
  });

  it('tells the two detail surfaces apart', () => {
    expect(parsePublicDetailPath('/listing/a-chair')).toEqual({ locale: 'en', slug: 'a-chair', surface: 'product' });
    expect(parsePublicDetailPath('/ar/service/logo-design')).toEqual({
      locale: 'ar',
      slug: 'logo-design',
      surface: 'service',
    });
    // Each narrow parser refuses the other surface outright, so neither can answer for the other.
    expect(parsePublicListingPath('/service/logo-design')).toBeNull();
    expect(parsePublicServicePath('/listing/a-chair')).toBeNull();
    expect(parsePublicServicePath('/service/logo-design')).toEqual({ locale: 'en', slug: 'logo-design' });
  });

  it('round-trips a slug back to the path it came from', () => {
    for (const locale of ['en', 'ar'] as const) {
      const path = publicListingPath(locale, 'a-chair');
      expect(parsePublicListingPath(path)).toEqual({ locale, slug: 'a-chair' });
    }
    for (const locale of ['en', 'ar'] as const) {
      const path = publicServicePath(locale, 'logo-design');
      expect(parsePublicServicePath(path)).toEqual({ locale, slug: 'logo-design' });
    }
    // English is the default locale and carries no prefix.
    expect(publicListingPath('en', 'a-chair')).toBe('/listing/a-chair');
    expect(publicListingPath('ar', 'a-chair')).toBe('/ar/listing/a-chair');
    expect(publicServicePath('en', 'logo-design')).toBe('/service/logo-design');
    expect(publicServicePath('ar', 'logo-design')).toBe('/ar/service/logo-design');
  });
});

/**
 * The CMS static page addresses.
 *
 * This is a **closed list**, not a slug shape, and that is the whole point of it. The public web has one route
 * file per entry and the middleware chooses the status before anything renders, which it can only do for a
 * path shape known ahead of any read. If this parser answered for an arbitrary segment instead, every unknown
 * URL on the site would become a candidate static page and the localized 404 would stop being reachable.
 */
describe('the CMS static page addresses', () => {
  it('names the page and the locale', () => {
    expect(parsePublicCmsPagePath('/terms')).toEqual({ locale: 'en', slug: 'terms' });
    expect(parsePublicCmsPagePath('/ar/terms')).toEqual({ locale: 'ar', slug: 'terms' });
    expect(parsePublicCmsPagePath('/refund-policy')).toEqual({ locale: 'en', slug: 'refund-policy' });
    // A trailing slash is the same address.
    expect(parsePublicCmsPagePath('/ar/privacy/')).toEqual({ locale: 'ar', slug: 'privacy' });
  });

  it('answers for every address on the list, in both locales', () => {
    for (const slug of cmsPageSlugs) {
      expect(parsePublicCmsPagePath(`/${slug}`), slug).toEqual({ locale: 'en', slug });
      expect(parsePublicCmsPagePath(`/ar/${slug}`), slug).toEqual({ locale: 'ar', slug });
    }
  });

  it('answers for nothing that is not on the list', () => {
    for (const path of [
      '/',
      '/ar',
      '/nope',
      '/file.txt',
      // Named in the route map but built as its own page, with its own content and tests.
      '/become-a-seller',
      // Reserved by the specification for surfaces nobody has built: an authored page cannot take them.
      '/featured',
      '/new',
      '/popular',
      '/deals',
      '/blog',
      // Real routes of other kinds.
      '/login',
      '/dashboard',
      '/marketplace',
      '/category/furniture',
      '/api/anything',
      // Near misses: a prefix, a suffix, a second segment and the wrong case are all different addresses.
      '/term',
      '/terms-and-conditions',
      'termsx',
      '/terms/old',
      '/ar/terms/old',
      '/Terms',
      '/TERMS',
      '/ar/Privacy',
      // Not paths at all.
      '',
      'terms',
      'https://example.com/terms',
      '//evil.example/terms',
    ]) {
      expect(parsePublicCmsPagePath(path), path).toBeNull();
    }
  });

  it('cannot be walked out of its own segment', () => {
    for (const path of ['/terms/../dashboard', '/terms%2Fold', '/..%2Fterms', '/ar/..%2Fdashboard']) {
      expect(parsePublicCmsPagePath(path), path).toBeNull();
    }
  });

  it('agrees with its own membership test', () => {
    for (const slug of cmsPageSlugs) expect(isCmsPageSlug(slug), slug).toBe(true);
    for (const slug of ['nope', 'become-a-seller', 'featured', 'Terms', '', 'terms/old']) {
      expect(isCmsPageSlug(slug), slug).toBe(false);
    }
  });

  it('builds the address it parses, in both locales', () => {
    for (const slug of cmsPageSlugs) {
      expect(parsePublicCmsPagePath(publicCmsPagePath('en', slug)), slug).toEqual({ locale: 'en', slug });
      expect(parsePublicCmsPagePath(publicCmsPagePath('ar', slug)), slug).toEqual({ locale: 'ar', slug });
    }
    expect(publicCmsPagePath('en', 'terms')).toBe('/terms');
    expect(publicCmsPagePath('ar', 'terms')).toBe('/ar/terms');
  });

  it('encodes rather than interpolates a slug it was handed', () => {
    // The builder also serves a *moved* target, which arrives from the database rather than from this list.
    expect(publicCmsPagePath('en', 'a b/c')).toBe('/a%20b%2Fc');
    expect(publicCmsPagePath('ar', '../dashboard')).toBe('/ar/..%2Fdashboard');
  });

  it('publishes the fixed indexable routes the sitemap needs, and not the home page', () => {
    // One list, read by the robots policy and by the sitemap, so the two cannot disagree about which fixed
    // paths may be indexed. The home page keeps its blanket noindex, so it is absent on purpose.
    expect([...indexableExactRoutes]).toEqual(['/categories', '/listings', '/marketplace', '/services']);
    for (const path of indexableExactRoutes) {
      expect(isPublicCatalogRoute(path), path).toBe(true);
      expect(isPublicCatalogRoute(`/ar${path}`), path).toBe(true);
      expect(robotsHeaderFor('web', path), path).toBeNull();
    }
    expect([...indexableExactRoutes]).not.toContain('/');
    expect(robotsHeaderFor('web', '/')).toBe('noindex');
  });

  it('holds the list to the specification route map', () => {
    // Every entry is one lowercase slug-shaped segment, and the list carries no duplicates.
    for (const slug of cmsPageSlugs) expect(slug, slug).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    expect(new Set(cmsPageSlugs).size).toBe(cmsPageSlugs.length);
    // The specification's static pages, minus `become-a-seller`, which is a built page of its own.
    expect(cmsPageSlugs.length).toBe(22);
    expect(cmsPageSlugs).not.toContain('become-a-seller');
  });
});

describe('the robots header', () => {
  it('is withheld on a catalogue route, so the page metadata is the one that answers', () => {
    for (const path of [
      '/categories',
      '/ar/categories',
      '/listings',
      '/ar/listings',
      '/listing/a-chair',
      '/services',
      '/ar/services',
      '/service/logo-design',
      '/ar/service/logo-design',
      '/category/furniture',
      '/ar/category/furniture',
      '/seller/good-shop',
      '/ar/seller/good-shop',
      '/marketplace',
      '/ar/marketplace',
    ]) {
      expect(robotsHeaderFor('web', path), path).toBeNull();
    }
  });

  it('is noindex everywhere else on the public web', () => {
    for (const path of ['/', '/login', '/dashboard/settings', '/reset-password', '/nope', '/search']) {
      expect(robotsHeaderFor('web', path), path).toBe('noindex');
    }
  });

  it('is noindex on every admin route without exception', () => {
    for (const path of ['/', '/listings', '/categories', '/listing/a-chair', '/services', '/service/x', '/category/x', '/seller/x', '/marketplace', '/dashboard']) {
      expect(robotsHeaderFor('admin', path), path).toBe('noindex');
    }
  });
});
