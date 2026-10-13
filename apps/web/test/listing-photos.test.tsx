import type { ListingImage, ListingSummary } from '@repo/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import { ListingGallery } from '../src/components/listing-gallery';
import { CARD_PHOTO_SIZES, ListingPhoto, anyPhotographed } from '../src/components/listing-photo';
import { ListingGrid } from '../src/components/listing-views';

/**
 * Photographs on the public surfaces, as markup (increment 0116).
 *
 * What is worth pinning here:
 *
 * **A `srcSet` the browser can actually choose from.** Three stored sizes, each with its width descriptor,
 * and a `sizes` hint — without the hint a browser assumes the full viewport and fetches the largest variant
 * for a card three to a row, which is the whole saving thrown away.
 *
 * **`width` and `height` are always on the element.** A card without them reflows the grid when the picture
 * arrives, and a reflowing catalogue is the most visible thing on the page.
 *
 * **The picture region is a decision about the grid, not about the card.** A page where nothing has a
 * photograph gets no frames at all; a page where something does gets one on every card.
 *
 * **`alt` is empty on a card and the title on a detail page**, because on a card the photograph sits inside a
 * link that already carries the title and on a detail page it is the content.
 *
 * **The gallery ships no JavaScript.** It is a scroll-snap track and in-page links; there is no state, no
 * handler and nothing for a browser to hydrate.
 */

const LABELS = {
  contactForPrice: en.Listings.contactForPrice,
  negotiable: en.Listings.negotiable,
};

function photo(id: string): ListingImage {
  return {
    id,
    variants: [
      { key: 'thumb', url: `https://media.test/${id}/thumb.webp`, width: 320, height: 240 },
      { key: 'card', url: `https://media.test/${id}/card.webp`, width: 800, height: 600 },
      { key: 'full', url: `https://media.test/${id}/full.webp`, width: 1600, height: 1200 },
    ],
  };
}

function listing(n: number, image: ListingImage | null): ListingSummary {
  return {
    id: `1111111${n}-1111-4111-8111-111111111111`,
    slug: `listing-${n}`,
    title: `Listing ${n}`,
    city: 'Cairo',
    priceMinor: '250000',
    currencyCode: 'EGP',
    currencyMinorUnit: 2,
    isNegotiable: false,
    listingTypeCode: 'product',
    primaryImage: image,
  };
}

const GALLERY_LABELS = {
  photosHeading: en.Listings.photosHeading,
  photoNumber: ({ number, total }: { number: number; total: number }) =>
    en.Listings.photoNumber.replace('{number}', String(number)).replace('{total}', String(total)),
};

/* ------------------------------------------------------------------------------------------------ */

describe('one photograph', () => {
  it('offers all three sizes with their width descriptors, and a sizes hint', () => {
    const html = renderToStaticMarkup(
      <ListingPhoto alt="" image={photo('a')} sizes={CARD_PHOTO_SIZES} />,
    );
    expect(html).toContain('https://media.test/a/thumb.webp 320w');
    expect(html).toContain('https://media.test/a/card.webp 800w');
    expect(html).toContain('https://media.test/a/full.webp 1600w');
    expect(html).toContain(`sizes="${CARD_PHOTO_SIZES}"`);
    // The middle one is the fallback a browser without `srcset` gets: a card-sized image, not a 1600px one.
    expect(html).toContain('src="https://media.test/a/card.webp"');
  });

  it('always carries intrinsic dimensions, so the grid does not move when it arrives', () => {
    const html = renderToStaticMarkup(<ListingPhoto alt="" image={photo('a')} sizes="100vw" />);
    expect(html).toContain('width="800"');
    expect(html).toContain('height="600"');
  });

  it('waits by default and loads eagerly only where it is asked to', () => {
    expect(renderToStaticMarkup(<ListingPhoto alt="" image={photo('a')} sizes="100vw" />)).toContain(
      'loading="lazy"',
    );
    expect(
      renderToStaticMarkup(<ListingPhoto alt="" image={photo('a')} sizes="100vw" loading="eager" />),
    ).toContain('loading="eager"');
  });

  it('renders nothing at all for a listing with no photograph', () => {
    expect(renderToStaticMarkup(<ListingPhoto alt="" image={null} sizes="100vw" />)).toBe('');
    expect(
      renderToStaticMarkup(<ListingPhoto alt="" image={{ id: 'a', variants: [] }} sizes="100vw" />),
    ).toBe('');
  });

  it('sorts the variants by width rather than trusting the order it was given', () => {
    const scrambled: ListingImage = {
      id: 'a',
      variants: [...photo('a').variants].reverse(),
    };
    const html = renderToStaticMarkup(<ListingPhoto alt="" image={scrambled} sizes="100vw" />);
    const order = [...html.matchAll(/(\d+)w/g)].map((match) => Number(match[1]));
    expect(order).toEqual([320, 800, 1600]);
  });
});

describe('the grid decides whether there is a picture region', () => {
  it('gives no card a frame when nothing on the page has a photograph', () => {
    const html = renderToStaticMarkup(
      <ListingGrid
        listings={[listing(1, null), listing(2, null)]}
        hrefFor={(slug) => `/listing/${slug}`}
        labels={LABELS}
      />,
    );
    // The region the card draws around a photograph. Absent entirely: a grid of empty frames reads as an
    // outage and not as a design, which is 0112's reasoning and it still holds.
    expect(html).not.toContain('aspect-[4/3]');
    expect(html).not.toContain('<img');
  });

  it('gives every card a frame as soon as one of them has a photograph', () => {
    const html = renderToStaticMarkup(
      <ListingGrid
        listings={[listing(1, photo('a')), listing(2, null), listing(3, null)]}
        hrefFor={(slug) => `/listing/${slug}`}
        labels={LABELS}
      />,
    );
    // Three regions, one picture: the row reads as one row rather than as a photograph beside two short
    // cards, and the two without one are quietly tinted.
    expect(html.split('aspect-[4/3]')).toHaveLength(4);
    expect(html.split('<img')).toHaveLength(2);
  });

  it('describes the picture to nobody on a card, because the link already names the listing', () => {
    const html = renderToStaticMarkup(
      <ListingGrid listings={[listing(1, photo('a'))]} hrefFor={(slug) => `/listing/${slug}`} labels={LABELS} />,
    );
    expect(html).toContain('alt=""');
    // The title is on the link, once, as the accessible name.
    expect(html).toContain('aria-label="Listing 1"');
  });

  it('answers the grid question from the data rather than from a flag', () => {
    expect(anyPhotographed([])).toBe(false);
    expect(anyPhotographed([{ primaryImage: null }])).toBe(false);
    expect(anyPhotographed([{ primaryImage: null }, { primaryImage: photo('a') }])).toBe(true);
  });
});

describe('the gallery on a detail page', () => {
  it('renders nothing for a listing with no photographs', () => {
    expect(renderToStaticMarkup(<ListingGallery images={[]} title="A flat" labels={GALLERY_LABELS} />)).toBe('');
  });

  it('draws one photograph as one picture, with no track and no thumbnail row', () => {
    const html = renderToStaticMarkup(
      <ListingGallery images={[photo('a')]} title="A flat" labels={GALLERY_LABELS} />,
    );
    expect(html.split('<img')).toHaveLength(2);
    expect(html).not.toContain('snap-x');
    expect(html).not.toContain('href="#photo-');
    // The photograph is the content here, so it is described.
    expect(html).toContain('alt="A flat"');
  });

  it('draws several as a snap track with a thumbnail link to each', () => {
    const html = renderToStaticMarkup(
      <ListingGallery images={[photo('a'), photo('b'), photo('c')]} title="A flat" labels={GALLERY_LABELS} />,
    );
    expect(html).toContain('snap-x');
    for (const n of [1, 2, 3]) {
      expect(html).toContain(`id="photo-${n}"`);
      expect(html).toContain(`href="#photo-${n}"`);
      expect(html).toContain(`aria-label="Photograph ${n} of 3"`);
    }
    // The first slide is eager and the rest wait: the first is what somebody is already looking at.
    expect(html.split('loading="eager"')).toHaveLength(2);
  });

  it('ships no JavaScript: it is a scroll container and in-page links', () => {
    const html = renderToStaticMarkup(
      <ListingGallery images={[photo('a'), photo('b')]} title="A flat" labels={GALLERY_LABELS} />,
    );
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<script');
  });

  it('names the gallery for a screen reader without drawing a heading nobody needs', () => {
    const html = renderToStaticMarkup(
      <ListingGallery images={[photo('a'), photo('b')]} title="A flat" labels={GALLERY_LABELS} />,
    );
    expect(html).toContain(`aria-label="${en.Listings.photosHeading}"`);
    expect(html).not.toContain(`<h2`);
  });
});
