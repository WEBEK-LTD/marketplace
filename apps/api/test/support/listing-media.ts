import type { ListingMediaRow } from '../../src/catalog/listing-images.js';

/**
 * The photographs double, shared by every suite whose service now asks for one (0116).
 *
 * **Why every one of those suites must override the port.** `LISTING_MEDIA_STORE` resolves to the real
 * `AppSystemStore`, whose pool points at `db.invalid`, so a suite that did not override it would have its media
 * read fail, and `ListingImagesService` turns a failed read into no photographs on purpose. The suite would
 * still pass — and would keep passing if the reader broke. An explicit double is what makes the absence of
 * photographs a stated fact rather than a swallowed error.
 *
 * `records` gives a suite the calls that were made, so "one call for a page of cards, not one per card" is a
 * property a test can assert rather than a claim in a comment.
 */
export interface MediaDouble {
  readonly publicListingMedia: (listingIds: readonly string[]) => Promise<readonly ListingMediaRow[]>;
  /** Every call's argument, in order. */
  readonly calls: string[][];
}

export function mediaDouble(
  rows: readonly ListingMediaRow[] = [],
  options: { readonly throws?: boolean } = {},
): MediaDouble {
  const calls: string[][] = [];
  return {
    calls,
    publicListingMedia: async (listingIds) => {
      calls.push([...listingIds]);
      if (options.throws === true) throw new Error('the photographs are unreachable');
      const wanted = new Set(listingIds);
      return rows.filter((row) => wanted.has(row.listingId));
    },
  };
}

/**
 * One photograph's three variants, as the reader returns them: ascending by width, which is the order
 * `public_listing_media` guarantees and `ListingImagesService` relies on.
 */
export function photoRows(input: {
  listingId: string;
  mediaId: string;
  position?: number;
  isPrimary?: boolean;
}): readonly ListingMediaRow[] {
  const { listingId, mediaId, position = 0, isPrimary = true } = input;
  return (
    [
      { key: 'thumb', width: 320, height: 240 },
      { key: 'card', width: 800, height: 600 },
      { key: 'full', width: 1600, height: 1200 },
    ] as const
  ).map((variant) => ({
    listingId,
    mediaId,
    mediaPosition: position,
    isPrimary,
    variantKey: variant.key,
    objectPath: `listing-variants/${listingId}/${variant.key}/${mediaId}.webp`,
    width: variant.width,
    height: variant.height,
  }));
}
