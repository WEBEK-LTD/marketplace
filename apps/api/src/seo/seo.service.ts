import { Inject, Injectable } from '@nestjs/common';
import {
  PUBLIC_LOCALES,
  REDIRECT_STATUS_CODES,
  REDIRECT_TO_PATH_PATTERN,
  SITEMAP_API_ENTRY_TYPES,
  SITEMAP_PAGE_SIZE,
  type PublicLocale,
  type RedirectStatusCode,
  type SitemapApiEntryType,
} from '@repo/contracts';
import { SeoUnavailableError } from './seo-errors.js';

/**
 * Public SEO reads: the authored `robots.txt` body, and the sitemap enumerations.
 *
 * Unauthenticated and read-only, like the public catalogue readers beside it. There is no user context to
 * carry, because a crawler-facing document is the same for everybody, and there is no permission to check,
 * because nothing here is private: every value exists in order to be served to a robot.
 *
 * **The rules are the database's.** Which listing belongs in a sitemap, which category, which page — all of
 * that is decided by the named readers in migration 0086, which call the same predicates the public pages
 * themselves resolve through. This service pages, shapes and hands back; it re-decides nothing. The one thing
 * it does decide is the page size, which comes from the shared contract so that the sitemap index and its
 * children cannot disagree about it.
 *
 * **No URLs.** Entries are slugs. Only the web app knows the public origin and the path shape each surface
 * owns, so building a URL here would be the API deciding something it has no business deciding — and it is
 * what would let a misconfigured origin leak into an answer that looks authoritative.
 */

/** The authored robots body, or nothing authored at all. */
export interface RobotsBodyRow {
  readonly localeCode: string;
  readonly body: string | null;
}

export interface SitemapCountRow {
  readonly entryType: string;
  readonly entryCount: number;
}

export interface SitemapEntryRow {
  readonly slug: string;
  readonly updatedAt: Date;
  /** Present for CMS static pages only: the locales in which that page actually resolves. */
  readonly locales?: readonly string[];
}

/** One answer from `app_private.public_redirect_resolve` (0090), or no row at all. */
export interface RedirectResolutionRow {
  readonly toPath: string;
  readonly statusCode: number;
}

export interface SeoStore {
  publicRedirectResolve(path: string): Promise<RedirectResolutionRow | null>;
  publicRobotsBody(): Promise<RobotsBodyRow | null>;
  publicSitemapCounts(): Promise<readonly SitemapCountRow[]>;
  publicSitemapPages(limit: number, offset: number): Promise<readonly SitemapEntryRow[]>;
  publicSitemapListings(limit: number, offset: number): Promise<readonly SitemapEntryRow[]>;
  publicSitemapServices(limit: number, offset: number): Promise<readonly SitemapEntryRow[]>;
  publicSitemapCategories(limit: number, offset: number): Promise<readonly SitemapEntryRow[]>;
  publicSitemapSellers(limit: number, offset: number): Promise<readonly SitemapEntryRow[]>;
}

export const SEO_STORE = Symbol('SEO_STORE');

export interface RobotsBody {
  readonly locale: string | null;
  readonly body: string | null;
}

export interface SitemapCounts {
  readonly pageSize: number;
  readonly counts: readonly { readonly type: SitemapApiEntryType; readonly entries: number }[];
}

/**
 * Where the redirect map sends one path, or that it names no redirect for it.
 *
 * A union rather than a nullable pair, so a caller cannot redirect to nowhere by forgetting a null check.
 */
export type RedirectResolution =
  | { readonly outcome: 'redirect'; readonly toPath: string; readonly statusCode: RedirectStatusCode }
  | { readonly outcome: 'none' };

export interface SitemapPage {
  readonly type: SitemapApiEntryType;
  readonly page: number;
  readonly pageSize: number;
  readonly entries: readonly {
    readonly slug: string;
    readonly updatedAt: string;
    readonly locales?: readonly PublicLocale[];
  }[];
}

@Injectable()
export class SeoService {
  constructor(@Inject(SEO_STORE) private readonly store: SeoStore) {}

  /**
   * The authored robots body, or nulls when nobody has authored one.
   *
   * Nothing authored is a state rather than a failure, so it is a 200 with nulls and never a 404. The web app
   * then serves a minimal correct document, which is the honest answer: there is no authored content and no
   * reason to invent directives.
   */
  async robots(): Promise<RobotsBody> {
    const row = await this.#read(() => this.store.publicRobotsBody());
    if (row === null) return { locale: null, body: null };
    // A row with a blank body is the same as no body: whitespace is not a directive.
    const body = row.body === null ? null : row.body.trim();
    return { locale: row.localeCode, body: body === null || body === '' ? null : body };
  }

  /**
   * Where the admin redirect map sends one path.
   *
   * **This is asked only about a path the public site has already decided answers 404.** The approved precedence
   * is LIVE PAGE WINS: a path that resolves to a live page or catalogue destination is rendered and this is
   * never consulted for it. Nothing here could enforce that ordering — the caller is the only party that knows
   * whether a live page answered — so this method does not pretend to, and answers the same for everybody.
   *
   * Every behaviour that looks like a decision belongs to migration 0030's resolver, which 0090's reader
   * composes: following a chain to its end, stopping after five hops, stopping rather than looping on a cycle,
   * and ignoring an entry that is switched off.
   *
   * The two shape checks below are not second opinions on the database. They are the same refusal the response
   * contract makes, applied before the value is put into a union a caller will act on: the table cannot store a
   * destination that is not a relative path or a status code outside its four, so a row that carries one means
   * something upstream is wrong, and acting on it would mean redirecting somebody somewhere nobody authored. A
   * row like that is reported as no redirect, which is the safe reading — the visitor gets the 404 they were
   * already getting.
   */
  async resolveRedirect(path: string): Promise<RedirectResolution> {
    const row = await this.#read(() => this.store.publicRedirectResolve(path));
    if (row === null) return { outcome: 'none' };
    if (!REDIRECT_TO_PATH_PATTERN.test(row.toPath)) return { outcome: 'none' };
    if (!(REDIRECT_STATUS_CODES as readonly number[]).includes(row.statusCode)) return { outcome: 'none' };
    // The map never sends a visitor to the address they just asked for; 0090's reader declines that, and this
    // repeats the refusal rather than trusting it, because the cost of being wrong is an endless redirect.
    if (row.toPath === path) return { outcome: 'none' };
    return { outcome: 'redirect', toPath: row.toPath, statusCode: row.statusCode as RedirectStatusCode };
  }

  /**
   * How many entries each kind of address would produce.
   *
   * Every kind the API answers for is reported, in the contract's own order, and a kind the database did not
   * mention reports zero rather than being left out — an index that silently omitted a kind would be
   * indistinguishable from one where that kind is empty, and a caller would have no way to tell.
   */
  async sitemapCounts(): Promise<SitemapCounts> {
    const rows = await this.#read(() => this.store.publicSitemapCounts());
    const byType = new Map(rows.map((row) => [row.entryType, row.entryCount]));
    return {
      pageSize: SITEMAP_PAGE_SIZE,
      counts: SITEMAP_API_ENTRY_TYPES.map((type) => ({
        type,
        entries: Math.max(0, Math.trunc(byType.get(type) ?? 0)),
      })),
    };
  }

  /**
   * One page of entries of one kind.
   *
   * A page past the end comes back empty rather than as a refusal: the set may have shrunk since the index was
   * read, and a crawler following a stale index should find nothing rather than an error.
   */
  async sitemapPage(type: SitemapApiEntryType, page: number): Promise<SitemapPage> {
    const offset = (page - 1) * SITEMAP_PAGE_SIZE;
    const rows = await this.#read(() => this.#enumerate(type, SITEMAP_PAGE_SIZE, offset));
    return {
      type,
      page,
      pageSize: SITEMAP_PAGE_SIZE,
      entries: rows.map((row) => ({
        slug: row.slug,
        updatedAt: row.updatedAt.toISOString(),
        // Narrowed to the locales this product has public surfaces for. `locales` arrives from the `locales`
        // table, so activating a third language would produce a code the shared contract cannot express; it is
        // dropped here rather than failing validation at the BFF and taking the whole sitemap down with it.
        ...(row.locales === undefined ? {} : { locales: row.locales.filter(isPublicLocale) }),
      })),
    };
  }

  #enumerate(type: SitemapApiEntryType, limit: number, offset: number): Promise<readonly SitemapEntryRow[]> {
    switch (type) {
      case 'page':
        return this.store.publicSitemapPages(limit, offset);
      case 'listing':
        return this.store.publicSitemapListings(limit, offset);
      case 'service':
        return this.store.publicSitemapServices(limit, offset);
      case 'category':
        return this.store.publicSitemapCategories(limit, offset);
      case 'seller':
        return this.store.publicSitemapSellers(limit, offset);
    }
  }

  /**
   * One read, with a failure turned into a 503 and the database's own words kept out of it.
   *
   * There is no permission to refuse and no row that could be missing, so the only outcomes are an answer and
   * a failure. A failure says only that the service is unavailable: a crawler has no use for a SQLSTATE, and a
   * public surface is the last place to start quoting one.
   */
  async #read<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch {
      throw new SeoUnavailableError();
    }
  }
}

/** Whether a locale code from the database is one the public surfaces exist for. */
function isPublicLocale(code: string): code is PublicLocale {
  return (PUBLIC_LOCALES as readonly string[]).includes(code);
}
