import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ListingImage, ListingImageVariant } from '@repo/contracts';

/**
 * The photographs a public card or detail page shows (0116).
 *
 * **One reader, one composer, four call sites.** The browse list, the search page, the category feed and the
 * homepage all build the same public card, so they all get their photographs from here rather than each
 * composing an address of its own. One definition of what a variant's URL is means one place to correct if the
 * storage layout ever changes.
 *
 * **A variant's address is an address.** `listing-variants` is 0012's one public bucket and it carries a read
 * policy that names it, so nothing here signs anything and nothing expires: the composed URL is
 * `{origin}/storage/v1/object/public/{object_path}`, and `object_path` already begins with the bucket name
 * because `listing_media_upload_target` writes it that way. A signed URL would be wrong rather than merely
 * redundant — it would expire inside a cached page and leave a broken image behind.
 *
 * **The original is never composed here.** It lives in the private `listing-originals` bucket as
 * `listing_media.original_object_path` and is not a `media_variants` row at all, so the public reader cannot
 * return it. The only keys that reach this file are the three served sizes.
 *
 * **A photograph is decoration, and a failed read costs the photograph rather than the page.** A catalogue that
 * answered 503 because a picture could not be read would be a worse answer than a card without one: the price,
 * the place and the title are the card's substance, and they came back. So a store failure is logged at error
 * level and resolves to no photographs — never to a failed request. That is the one place in this file where
 * something is swallowed, and it is deliberate.
 */

/** One row of `app_private.public_listing_media(uuid[])` (0114). */
export interface ListingMediaRow {
  readonly listingId: string;
  readonly mediaId: string;
  readonly mediaPosition: number;
  readonly isPrimary: boolean;
  readonly variantKey: string;
  readonly objectPath: string;
  readonly width: number;
  readonly height: number;
}

export interface ListingMediaStore {
  /** `app_private.public_listing_media(uuid[])`: the published variants of the listings named. */
  publicListingMedia(listingIds: readonly string[]): Promise<readonly ListingMediaRow[]>;
}

export const LISTING_MEDIA_STORE = Symbol('LISTING_MEDIA_STORE');

/**
 * The origin that serves stored objects — the Supabase project URL, with no trailing slash.
 *
 * A token rather than a literal because this is deployment configuration, and a token rather than a direct read
 * of the environment because a service that reads `process.env` cannot be given a different origin in a test.
 */
export const MEDIA_PUBLIC_ORIGIN = Symbol('MEDIA_PUBLIC_ORIGIN');

/** The three sizes a public card or gallery may use, smallest first. */
const SERVED_KEYS = ['thumb', 'card', 'full'] as const;
type ServedKey = (typeof SERVED_KEYS)[number];

function isServedKey(value: string): value is ServedKey {
  return (SERVED_KEYS as readonly string[]).includes(value);
}

/** No photographs, shared so the common case allocates nothing. */
const NONE: ReadonlyMap<string, readonly ListingImage[]> = new Map();

/**
 * Composes one variant's public address.
 *
 * Exported for the test that pins the shape: the path is Supabase Storage's own public object route, and a
 * change to it is a change a reader would notice as a broken image rather than as a failure.
 */
export function publicObjectUrl(origin: string, objectPath: string): string {
  return `${origin.replace(/\/+$/, '')}/storage/v1/object/public/${objectPath}`;
}

@Injectable()
export class ListingImagesService {
  private readonly logger = new Logger(ListingImagesService.name);

  constructor(
    @Inject(LISTING_MEDIA_STORE) private readonly store: ListingMediaStore,
    @Inject(MEDIA_PUBLIC_ORIGIN) private readonly origin: string,
  ) {}

  /**
   * The photographs of the listings named, keyed by listing id.
   *
   * One round trip for a whole page of cards, which is why the reader takes an array. A listing with no
   * photographs is absent from the map rather than present with an empty array, so a caller asks the map and
   * gets `undefined` exactly when there is nothing to show.
   */
  async forListings(listingIds: readonly string[]): Promise<ReadonlyMap<string, readonly ListingImage[]>> {
    const unique = [...new Set(listingIds)];
    if (unique.length === 0) return NONE;

    let rows: readonly ListingMediaRow[];
    try {
      rows = await this.store.publicListingMedia(unique);
    } catch {
      // Deliberate: see the file header. The card keeps its substance and loses its picture.
      this.logger.error('The photographs of a page of listings could not be read.');
      return NONE;
    }

    return this.#group(rows);
  }

  /** The photographs of one listing, in order, primary first. */
  async forListing(listingId: string): Promise<readonly ListingImage[]> {
    const byListing = await this.forListings([listingId]);
    return byListing.get(listingId) ?? [];
  }

  /** The one photograph a card shows, or null — the primary if there is one, else the first. */
  primaryOf(images: readonly ListingImage[] | undefined): ListingImage | null {
    return images === undefined || images.length === 0 ? null : images[0]!;
  }

  /**
   * Rows into photographs.
   *
   * The reader orders by listing, then position, then variant width, so the rows of one photograph arrive
   * together and its variants arrive smallest first. This walks them in that order and keeps it: a caller that
   * wants the smallest takes the first variant, and the primary photograph is moved to the front of its
   * listing so `primaryOf` is the first element rather than a search.
   *
   * A variant whose key is not one of the three served sizes is dropped rather than carried: the contract's
   * enum names exactly three, and a fourth could only come from a row this release did not write.
   */
  #group(rows: readonly ListingMediaRow[]): ReadonlyMap<string, readonly ListingImage[]> {
    const byListing = new Map<string, { images: ListingImage[]; primaryId: string | null }>();
    const byMedia = new Map<string, ListingImageVariant[]>();

    for (const row of rows) {
      if (!isServedKey(row.variantKey)) continue;

      let variants = byMedia.get(row.mediaId);
      if (variants === undefined) {
        variants = [];
        byMedia.set(row.mediaId, variants);

        let listing = byListing.get(row.listingId);
        if (listing === undefined) {
          listing = { images: [], primaryId: null };
          byListing.set(row.listingId, listing);
        }
        listing.images.push({ id: row.mediaId, variants });
        if (row.isPrimary) listing.primaryId = row.mediaId;
      }

      variants.push({
        key: row.variantKey,
        url: publicObjectUrl(this.origin, row.objectPath),
        width: row.width,
        height: row.height,
      });
    }

    const result = new Map<string, readonly ListingImage[]>();
    for (const [listingId, entry] of byListing) {
      // A photograph that lost all three of its variants is not a photograph. Dropping it here rather than
      // earlier keeps the ordering walk above simple.
      const images = entry.images.filter((image) => image.variants.length > 0);
      if (images.length === 0) continue;

      if (entry.primaryId !== null) {
        const index = images.findIndex((image) => image.id === entry.primaryId);
        if (index > 0) {
          const [primary] = images.splice(index, 1);
          images.unshift(primary!);
        }
      }
      result.set(listingId, images);
    }
    return result;
  }
}
