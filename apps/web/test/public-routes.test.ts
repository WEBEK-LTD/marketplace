import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmsPageSlugs, indexableExactRoutes, isAdminSurfacePath } from '@repo/config';
import {
  PUBLIC_SERVED_EXACT_PATHS,
  PUBLIC_SERVED_ONE_SEGMENT_PREFIXES,
  publicWebServes,
} from '../src/server/public-routes';

/**
 * The declared set of served addresses, held to the route tree itself.
 *
 * This is the test that makes `publicWebServes` safe to build the redirect map's precedence on. The approved rule is
 * LIVE PAGE WINS, and it is only as good as the answer to "does this app serve this path" — so the answer is not
 * allowed to be a hand-maintained guess. The route tree under `src/app/[locale]` is walked here, every route is
 * derived from the `page.tsx` files found, and the two sets are compared **in both directions**: a route added
 * without declaring it fails, and a declaration for a route that no longer exists fails too.
 *
 * The consequence of it failing is worth stating, because it is the reason this test is strict rather than
 * informative: a route present in the tree and missing from the declaration would be a live page the redirect map
 * could shadow.
 */

const LOCALE_ROOT = join(import.meta.dirname, '..', 'src', 'app', '[locale]');

/** Every directory under the locale root that holds a `page.tsx`, as the route it serves. */
function routesInTree(): { readonly exact: string[]; readonly dynamic: string[] } {
  const exact: string[] = [];
  const dynamic: string[] = [];

  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'page.tsx')) {
      const relativePath = relative(LOCALE_ROOT, directory);
      const route = relativePath === '' ? '/' : `/${relativePath.split(sep).join('/')}`;
      (route.includes('[') ? dynamic : exact).push(route);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(directory, entry.name));
    }
  };

  walk(LOCALE_ROOT);
  return { exact: exact.sort(), dynamic: dynamic.sort() };
}

describe('the declared served paths and the route tree', () => {
  it('is the same set of fixed addresses, in both directions', () => {
    expect([...PUBLIC_SERVED_EXACT_PATHS].sort()).toEqual(routesInTree().exact);
  });

  it('is the same set of one-segment shapes, in both directions', () => {
    // A route file with one dynamic segment is declared as its prefix, so `/listing/[slug]` is `/listing/`.
    const fromTree = routesInTree()
      .dynamic.map((route) => `${route.slice(0, route.lastIndexOf('/') + 1)}`)
      .sort();
    expect([...PUBLIC_SERVED_ONE_SEGMENT_PREFIXES].sort()).toEqual(fromTree);
  });

  it('has no catch-all anywhere, which is what makes the answer complete', () => {
    // A catch-all would serve every unknown URL, and "not in these two sets" would stop meaning anything.
    const hasCatchAll = routesInTree().dynamic.some((route) => route.includes('[...'));
    expect(hasCatchAll).toBe(false);
  });

  it('has a page file for every declared fixed address', () => {
    for (const route of PUBLIC_SERVED_EXACT_PATHS) {
      const directory = route === '/' ? LOCALE_ROOT : join(LOCALE_ROOT, ...route.slice(1).split('/'));
      expect(statSync(join(directory, 'page.tsx')).isFile(), route).toBe(true);
    }
  });
});

describe('publicWebServes', () => {
  it('serves every fixed address, in both languages', () => {
    for (const route of PUBLIC_SERVED_EXACT_PATHS) {
      expect(publicWebServes(route), route).toBe(true);
      const arabic = route === '/' ? '/ar' : `/ar${route}`;
      expect(publicWebServes(arabic), arabic).toBe(true);
    }
  });

  it('serves a dynamic route with exactly one further segment', () => {
    expect(publicWebServes('/listing/a-chair')).toBe(true);
    expect(publicWebServes('/ar/listing/a-chair')).toBe(true);
    expect(publicWebServes('/category/furniture')).toBe(true);
    expect(publicWebServes('/seller/good-shop')).toBe(true);
    expect(publicWebServes('/service/a-haircut')).toBe(true);
    expect(publicWebServes('/blog/a-lovely-post')).toBe(true);
    expect(publicWebServes('/ar/blog/a-lovely-post')).toBe(true);
    expect(publicWebServes('/dashboard/messages/11111111-1111-4111-8111-111111111111')).toBe(true);
  });

  it('serves the blog index and one post, and nothing deeper (0092)', () => {
    expect(publicWebServes('/blog')).toBe(true);
    expect(publicWebServes('/ar/blog')).toBe(true);
    // A post is one segment. `/blog/a-post/comments` is not a route this increment built, and a comment section is
    // explicitly out of its scope, so the address is unserved and reaches the redirect map like any other 404.
    expect(publicWebServes('/blog/a-lovely-post/comments')).toBe(false);
    expect(publicWebServes('/blog/')).toBe(true);
  });

  it('serves a dynamic route whether or not the row exists', () => {
    // Routed is not the same as found. A missing row becomes the catalogue's own 404 in the middleware, which is a
    // different path to the same status and must reach the map just the same.
    expect(publicWebServes('/listing/no-such-listing-anywhere')).toBe(true);
  });

  it('does not serve two further segments, or none', () => {
    expect(publicWebServes('/listing/a-chair/edit')).toBe(false);
    expect(publicWebServes('/listing/')).toBe(false);
    expect(publicWebServes('/listing')).toBe(false);
    expect(publicWebServes('/category/furniture/sofas')).toBe(false);
  });

  it('does not serve an address nobody wrote a route for', () => {
    for (const path of [
      '/old-campaign',
      '/ar/old-campaign',
      '/how-it-works',
      '/featured',
      '/deals',
      '/sellers',
      '/cart',
      '/checkout',
      '/dashboard/orders',
      '/dashboard/reviews',
    ]) {
      expect(publicWebServes(path), path).toBe(false);
    }
  });

  it('tolerates a trailing slash on a fixed address, which is the same address', () => {
    expect(publicWebServes('/about/')).toBe(true);
    expect(publicWebServes('/ar/about/')).toBe(true);
  });

  it('answers for the root in both languages', () => {
    expect(publicWebServes('/')).toBe(true);
    expect(publicWebServes('/ar')).toBe(true);
    expect(publicWebServes('/ar/')).toBe(true);
  });

  it('refuses something that is not a path at all', () => {
    expect(publicWebServes('about')).toBe(false);
    expect(publicWebServes('')).toBe(false);
  });

  /**
   * The staff console is reserved, not served (0108).
   *
   * The proxy returns for a console path before `publicWebServes` is consulted, so in production this answer is
   * never read. It is asserted anyway, because of what it would mean if it changed: a path this function calls
   * served is a path the proxy would NOT hand to the SEO redirect map, and a path it calls unserved is one it
   * would. 0030 admits `/admin/users` as a storable `from_path`, so if the proxy's early return were ever removed,
   * an operator-authored redirect could shadow a live console page. This keeps the second line of that defence
   * stated rather than accidental.
   */
  it('reserves the console surface, so no console path is ever a public address', () => {
    for (const path of ['/admin', '/admin/', '/admin/login', '/admin/users', '/admin/api/faqs', '/ar/admin', '/ar/admin/users']) {
      expect(publicWebServes(path), path).toBe(false);
    }
    // And `isAdminSurfacePath` agrees about the same paths, so the proxy's branch and this reservation cannot
    // disagree about where the console begins. Whole segments only: `/administrator` is a public 404, not a console.
    for (const path of ['/admin', '/admin/login', '/admin/api/faqs']) {
      expect(isAdminSurfacePath(path), path).toBe(true);
    }
    for (const path of ['/administrator', '/ar/admin', '/adminish/x', '/']) {
      expect(isAdminSurfacePath(path), path).toBe(false);
    }
  });

  /** No public surface may ever come to occupy the console's address. */
  it('declares no public route, CMS slug or sitemap entry under the console prefix', () => {
    for (const path of PUBLIC_SERVED_EXACT_PATHS) {
      expect(isAdminSurfacePath(path), path).toBe(false);
    }
    for (const prefix of PUBLIC_SERVED_ONE_SEGMENT_PREFIXES) {
      expect(isAdminSurfacePath(prefix.replace(/\/$/, '')), prefix).toBe(false);
    }
    for (const slug of cmsPageSlugs) {
      expect(slug, slug).not.toBe('admin');
    }
    for (const route of indexableExactRoutes) {
      expect(isAdminSurfacePath(route), route).toBe(false);
    }
  });
});
