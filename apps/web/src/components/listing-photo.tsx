import type { ListingImage, ListingImageVariant } from '@repo/contracts';

/**
 * A listing's photograph, on a card and on a detail page (0116).
 *
 * **Three stored sizes, no image optimizer.** `listing_media_attach` writes exactly three WebP variants per
 * photograph — `thumb`, `card` and `full` — and they are already the sizes a page needs. So this renders a plain
 * `<img>` with a `srcSet` built from those three and lets the browser pick, rather than routing every picture
 * through Next's optimizer: the resizing has already happened, at upload, once per photograph instead of once
 * per viewport. That also means no `remotePatterns` entry, no optimizer running on every cold request, and no
 * build-time dependency on knowing the storage host.
 *
 * **`width` and `height` are always set**, from the variant's own stored dimensions, because a card without
 * them reflows the whole grid when the picture arrives. The region the card gives it is a fixed 4:3, so the
 * image is `object-cover` inside it: a property photograph is shot in many ratios and cropping it is the only
 * way a row of cards stays a row.
 *
 * **`alt` is empty on a card and the title on a detail page.** On a card the photograph sits inside a link that
 * is already labelled with the listing's title, so describing it again would make a screen reader read the same
 * words twice. On the detail page the photograph is the content, and the title is the best description anyone
 * has: there is no caption field on `listing_media` and inventing one from the city would be a description of
 * something nobody wrote.
 *
 * **A listing with no photograph renders nothing here, deliberately.** It is the caller that decides whether the
 * card gets a picture region at all — see {@link anyPhotographed} — and when it does, this component returning
 * `null` leaves that region quietly tinted. No placeholder graphic, no icon and no "image missing" line: a grid
 * of twenty identical grey rectangles reads as an outage rather than as a design, which is the reasoning 0112
 * recorded for leaving the region out altogether, and it holds just as well for what goes inside it.
 */

/** The widths the browser is told about, smallest first. */
function sortedVariants(image: ListingImage): readonly ListingImageVariant[] {
  return [...image.variants].sort((a, b) => a.width - b.width);
}

/** The variant a browser that ignores `srcSet` gets: the middle one, which is the card size. */
function fallbackVariant(variants: readonly ListingImageVariant[]): ListingImageVariant {
  return variants.find((variant) => variant.key === 'card') ?? variants[variants.length - 1]!;
}

export interface ListingPhotoProps {
  readonly image: ListingImage | null;
  /**
   * What a screen reader hears. Empty on a card, where the enclosing link already carries the title.
   *
   * It is required rather than defaulted so that every call site has had to decide: an alt text that appeared
   * by default would be wrong in exactly the places nobody looked at.
   */
  readonly alt: string;
  /**
   * The `sizes` hint — how wide this image will actually be drawn, in CSS terms.
   *
   * Without it a browser assumes the full viewport width and fetches the largest variant for a card three to a
   * row, which is the whole saving thrown away.
   */
  readonly sizes: string;
  /** `eager` for the one photograph that is already on screen when the page opens; everything else waits. */
  readonly loading?: 'eager' | 'lazy';
  readonly className?: string;
}

export function ListingPhoto({ image, alt, sizes, loading = 'lazy', className }: ListingPhotoProps) {
  if (image === null || image.variants.length === 0) return null;

  const variants = sortedVariants(image);
  const fallback = fallbackVariant(variants);

  return (
    /* eslint-disable-next-line @next/next/no-img-element -- three pre-sized WebP variants; see the file note. */
    <img
      alt={alt}
      className={className ?? 'h-full w-full object-cover'}
      decoding="async"
      height={fallback.height}
      loading={loading}
      sizes={sizes}
      src={fallback.url}
      srcSet={variants.map((variant) => `${variant.url} ${variant.width}w`).join(', ')}
      width={fallback.width}
    />
  );
}

/**
 * Whether anything in this collection has a photograph.
 *
 * **The picture region is a decision about the grid, not about the card.** If no listing on the page has a
 * photograph the cards are typographic and complete, exactly as they were before this increment — that is the
 * ordinary state of a catalogue whose sellers have not uploaded anything yet, and giving every card an empty
 * frame would make the page look broken. If some listing does, every card on the page gets the region, so the
 * row reads as one row rather than as photographs interleaved with shorter cards.
 */
export function anyPhotographed(
  items: readonly { readonly primaryImage: ListingImage | null }[],
): boolean {
  return items.some((item) => item.primaryImage !== null);
}

/** The `sizes` hint for the catalogue grid: three up on a wide screen, two on a tablet, one on a phone. */
export const CARD_PHOTO_SIZES = '(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw';
