import type { ListingImage } from '@repo/contracts';
import { FOCUS_RING, cx } from '@repo/ui';
import { ListingPhoto } from './listing-photo';

/**
 * A listing's photographs on its own page (0116).
 *
 * **No JavaScript, deliberately.** A gallery is the obvious place to reach for a client component holding an
 * index in state, and this is not one: the photographs are laid out in a horizontal scroll-snap track and the
 * thumbnails below it are ordinary in-page links to each slide. A browser scrolls to a fragment and snaps,
 * which is the whole mechanism. So the gallery works for a crawler, works before hydration, works with
 * JavaScript off, and adds nothing to the page's client bundle — and a person can still swipe it on a phone
 * and arrow through it with a keyboard, because a scroll container is focusable and scrollable by default.
 *
 * **The first photograph is eager, the rest lazy.** The primary is at the top of the page and is very likely
 * the largest thing a visitor waits for; the others are off to the side of a track they may never scroll.
 *
 * **One photograph is not a gallery**, so it renders as a single picture with no track and no thumbnail row —
 * a strip of one thumbnail under one photograph is furniture around nothing.
 *
 * **`alt` is the listing's title here**, not empty as it is on a card: on this page the photograph is the
 * content rather than an illustration of a link that already names it. There is no caption field on
 * `listing_media` and nothing invents one — a description assembled from the city and the price would be a
 * claim about the picture that nobody made.
 */

export interface ListingGalleryLabels {
  /** The heading for the thumbnail row, for a screen reader. Never drawn. */
  readonly photosHeading: string;
  /** One thumbnail's accessible name — `'Photograph {number} of {total}'`, already interpolated. */
  readonly photoNumber: (input: { number: number; total: number }) => string;
}

export function ListingGallery({
  images,
  title,
  labels,
  idPrefix = 'photo',
}: {
  readonly images: readonly ListingImage[];
  /** The listing's title, which is the only description of the photographs that exists. */
  readonly title: string;
  readonly labels: ListingGalleryLabels;
  /** Prefix for the slide ids the thumbnails point at. One listing per page, so the default suffices. */
  readonly idPrefix?: string;
}) {
  if (images.length === 0) return null;

  const first = images[0]!;

  if (images.length === 1) {
    return (
      <figure className="overflow-hidden rounded-2xl border border-hairline bg-surface-muted">
        <div className="relative aspect-[3/2] w-full">
          <ListingPhoto alt={title} image={first} loading="eager" sizes="(min-width: 1024px) 60vw, 100vw" />
        </div>
      </figure>
    );
  }

  return (
    <section aria-label={labels.photosHeading}>
      {/*
        The track. `snap-mandatory` so a swipe lands on a photograph rather than between two, and
        `scroll-smooth` so a thumbnail link slides rather than jumps. `overflow-x-auto` is what makes the
        container focusable and arrow-scrollable without a single line of script.
      */}
      <ul className="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth rounded-2xl">
        {images.map((image, index) => (
          <li
            key={image.id}
            id={`${idPrefix}-${index + 1}`}
            className="relative aspect-[3/2] w-full shrink-0 snap-center overflow-hidden rounded-2xl border border-hairline bg-surface-muted"
          >
            <ListingPhoto
              alt={index === 0 ? title : ''}
              image={image}
              loading={index === 0 ? 'eager' : 'lazy'}
              sizes="(min-width: 1024px) 60vw, 100vw"
            />
          </li>
        ))}
      </ul>

      {/*
        The thumbnails. Links rather than buttons, because that is what they are — each one addresses a slide
        that exists in the document at a fragment. A `title` is not enough for a link whose content is an
        image, so each carries its own accessible name and the images inside are decorative.
      */}
      <ul className="mt-3 flex flex-wrap gap-2">
        {images.map((image, index) => (
          <li key={image.id}>
            <a
              href={`#${idPrefix}-${index + 1}`}
              aria-label={labels.photoNumber({ number: index + 1, total: images.length })}
              className={cx(
                'block aspect-[3/2] w-20 overflow-hidden rounded-lg border border-hairline bg-surface-muted',
                'transition-opacity duration-200 hover:opacity-80',
                FOCUS_RING,
              )}
            >
              <ListingPhoto alt="" image={image} sizes="80px" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
