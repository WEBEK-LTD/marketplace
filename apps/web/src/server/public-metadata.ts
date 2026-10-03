import 'server-only';
import { cache } from 'react';
import type { Metadata } from 'next';
import type { PublicLocale } from '@repo/config';
import { readSeoMetadata, type SeoMetadataTarget } from './bff/seo-metadata';

/**
 * How a public surface's own metadata and the administrator's override become one document head (Phase 8-F).
 *
 * **One function, used by every surface**, so the merge happens once. Six screens each merging an override their own
 * way would be six chances for one of them to let a stored value do something the owner's rules say it cannot.
 *
 * **Both owner rules are already applied before this runs**, in the database:
 *
 *   * a stored `canonicalPath` reaches here only for a `route` and a `page`: the reader returns it as null for a
 *     listing, a category and a seller. **It is enforced a second time below anyway**, from the target this surface
 *     named, because a value that arrives where it should not have is exactly the case worth defending against — the
 *     owner's rule is that those three surfaces *retain* their derived canonical, and a rule that holds only while
 *     every layer upstream behaves is not the rule that was approved.
 *   * `robotsDirectives` holds restrictions only. So the merge below can be written as a plain conjunction — the page
 *     decides whether it is indexable and a directive may only take that away — and a stored `index` on a sold
 *     listing, a suspended seller or a filtered category view is simply not a value that exists by this point.
 *
 * **The override never adds a surface to the index.** `index` and `follow` start from the page's own decision and can
 * only be narrowed. That is the whole of what keeps the listing-state table and 8-D's filtered-view rule intact.
 *
 * **OpenGraph appears only when an override asks for it.** Serving OG tags derived from every page's own title would
 * be a site-wide change this increment was not asked for; serving the two the administrator wrote is the feature.
 *
 * **`og:image` is deliberately not emitted.** A share image is a *storage* object path, not a path on this site, and
 * turning one into a URL needs an origin for the media bucket that this app does not have and will not guess — the
 * same reason the sitemaps answer 404 until `PUBLIC_WEB_ORIGIN` is set. The image is stored, and the admin screen
 * shows which one was chosen; nothing here pretends it can address it.
 *
 * **An override is never load-bearing.** Every failure path in the reader returns no override, so a page whose
 * metadata could not be read renders exactly the head it rendered before this existed.
 */

/** What a surface derives from its own content, before any override is considered. */
export interface DerivedMetadata {
  readonly title: string;
  readonly description?: string | null;
  /** Always the surface's own address. An override may replace it only where the owner's rule allows. */
  readonly canonical: string;
  readonly languages: Readonly<Record<PublicLocale, string>>;
  readonly index: boolean;
  readonly follow: boolean;
}

/**
 * One read per request per target, shared by `generateMetadata` and anything else that asks.
 *
 * `cache` is React's per-request memo, which is what keeps a surface that asks twice from making two internal hops.
 */
const lookup = cache(
  async (key: string): Promise<Awaited<ReturnType<typeof readSeoMetadata>>> => {
    const target = JSON.parse(key) as SeoMetadataTarget;
    return await readSeoMetadata(target);
  },
);

/** The document head for one surface: what it derived, narrowed and replaced by the override where that is allowed. */
export async function metadataWithOverride(
  target: SeoMetadataTarget,
  derived: DerivedMetadata,
): Promise<Metadata> {
  const override = await lookup(JSON.stringify(target));

  const title = override?.metaTitle ?? derived.title;
  const description = override?.metaDescription ?? derived.description ?? null;
  // Owner decision 1, enforced here as well as in the reader. A listing, a category and a seller keep the
  // self-referencing address they derive, and this surface knows which kind it is — so a stored canonical that
  // reached this far regardless still goes nowhere.
  const honoursCanonical = 'routePath' in target || target.entityType === 'page';
  const canonical = (honoursCanonical ? override?.canonicalPath : null) ?? derived.canonical;

  const held = new Set(override?.robotsDirectives ?? []);
  const openGraph =
    override === null || (override.ogTitle === null && override.ogDescription === null)
      ? undefined
      : {
          ...(override.ogTitle === null ? {} : { title: override.ogTitle }),
          ...(override.ogDescription === null ? {} : { description: override.ogDescription }),
        };

  return {
    title,
    ...(description === null ? {} : { description }),
    alternates: { canonical, languages: { ...derived.languages } },
    // Stated on every branch, as every surface here already does: the root layout's default is `noindex, nofollow`
    // and metadata merges from the root down, so a page that says nothing inherits that refusal.
    robots: {
      // A conjunction, not a choice. The page decides; a directive may only take it away.
      index: derived.index && !held.has('noindex'),
      follow: derived.follow && !held.has('nofollow'),
      ...(held.has('noarchive') ? { noarchive: true } : {}),
      ...(held.has('nosnippet') ? { nosnippet: true } : {}),
      ...(held.has('noimageindex') ? { noimageindex: true } : {}),
    },
    ...(openGraph === undefined ? {} : { openGraph }),
  };
}
