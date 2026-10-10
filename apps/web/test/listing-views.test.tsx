import type { ListingDetail, ListingSummary } from '@repo/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { ListingPrice, formatListingAmount } from '../src/components/listing-price';
import {


  ListingCard,
  ListingDetailView,
  ListingGrid,
  ListingGridSkeleton,
  ListingMessage,
} from '../src/components/listing-views';

/**
 * The text a reader actually gets, with the markup taken out.
 *
 * 0110 sets a price as a composed figure — the currency code in a small raised mark, the amount large and
 * tabular — so "EGP 2500.00" is no longer one contiguous run in the HTML source: there is a `</span>` between
 * the code and the number, and React puts its own separator between adjacent text nodes. The invariant was
 * never about the markup, though. It is that the price **reads** as "EGP 2500.00" — to a person, to a screen
 * reader, and to anyone who copies it — and that is what this asserts.
 */
function textOf(html: string): string {
  return html
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}


/**
 * The public listing surfaces as markup (Phase 4-B).
 *
 * Three things are worth pinning here. The price states, because they are the owner's decision and
 * silently formatting a minor amount wrongly is the kind of bug nobody reports. The structure a screen
 * reader walks. And, above all, the absence of anything the page has no right to show: a seller's legal
 * name, an email address, a phone number or a coordinate must not be able to reach the HTML even when it
 * somehow reaches the component.
 */

const EN = en.Listings;
const AR = ar.Listings;

const LABELS = {
  contactForPrice: EN.contactForPrice,
  negotiable: EN.negotiable,
  noLongerAvailable: EN.noLongerAvailable,
  sellerHeading: EN.sellerHeading,
  categoryHeading: EN.categoryHeading,
  detailsHeading: EN.detailsHeading,
  tagsHeading: EN.tagsHeading,
  descriptionHeading: EN.descriptionHeading,
  yes: EN.yes,
  no: EN.no,
} as const;

const SUMMARY: ListingSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'a-listing',
  title: 'A listing title',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: false,
  listingTypeCode: 'product',
};

const DETAIL: ListingDetail = {
  ...SUMMARY,
  description: 'A description long enough to be real.',
  contentLanguage: 'ar',
  createdAt: '2026-01-01T12:00:00.000Z',
  availability: 'available',
  category: { slug: 'furniture', name: 'Furniture' },
  seller: { slug: 'good-shop', displayName: 'Good Shop' },
  attributes: [
    { key: 'width', label: 'Width', unit: 'cm', kind: 'number', text: '180', boolean: null, options: [] },
    { key: 'boxed', label: 'Boxed', unit: null, kind: 'boolean', text: null, boolean: true, options: [] },
    { key: 'colour', label: 'Colour', unit: null, kind: 'multi_select', text: null, boolean: null, options: ['Red', 'Blue'] },
  ],
  tags: [{ slug: 'handmade', name: 'Handmade' }],
};

describe('a listing price', () => {
  it('formats a minor amount using the currency it was listed in', () => {
    expect(formatListingAmount('250000', 'EGP', 2)).toBe('EGP 2500.00');
    expect(formatListingAmount('1', 'EGP', 2)).toBe('EGP 0.01');
    expect(formatListingAmount('250000', 'KWD', 3)).toBe('KWD 250.000');
    expect(formatListingAmount('7', 'JPY', 0)).toBe('JPY 7');
  });

  it('never converts or re-denominates', () => {
    // The same number of minor units in two currencies stays the same number.
    expect(formatListingAmount('250000', 'USD', 2)).toBe('USD 2500.00');
    expect(formatListingAmount('250000', 'EGP', 2)).toBe('EGP 2500.00');
  });

  it('says "contact for price" when the listing carries no amount', () => {
    expect(formatListingAmount(null, 'EGP', 2)).toBeNull();
    const html = renderToStaticMarkup(
      <ListingPrice priceMinor={null} currencyCode="EGP" currencyMinorUnit={2} isNegotiable={false} labels={LABELS} />,
    );
    expect(html).toContain(EN.contactForPrice);
    expect(html).not.toContain('EGP');
  });

  it('marks a negotiable price, and does not mark one that is only "contact for price"', () => {
    const withAmount = renderToStaticMarkup(
      <ListingPrice priceMinor="250000" currencyCode="EGP" currencyMinorUnit={2} isNegotiable labels={LABELS} />,
    );
    expect(textOf(withAmount)).toContain('EGP 2500.00');
    expect(withAmount).toContain(EN.negotiable);

    const withoutAmount = renderToStaticMarkup(
      <ListingPrice priceMinor={null} currencyCode="EGP" currencyMinorUnit={2} isNegotiable labels={LABELS} />,
    );
    expect(withoutAmount).not.toContain(EN.negotiable);
  });

  it('shows "contact for price" rather than a broken string when an amount cannot be formatted', () => {
    expect(formatListingAmount('not-a-number', 'EGP', 2)).toBeNull();
  });
});

describe('a listing card', () => {
  it('shows the title, city and price, and links to the listing', () => {
    const html = renderToStaticMarkup(
      <ListingCard listing={SUMMARY} href="/listing/a-listing" labels={LABELS} />,
    );
    expect(html).toContain('A listing title');
    expect(html).toContain('Cairo');
    expect(textOf(html)).toContain('EGP 2500.00');
    expect(html).toContain('href="/listing/a-listing"');
  });

  it('omits the city rather than leaving an empty line when there is none', () => {
    const html = renderToStaticMarkup(
      <ListingCard listing={{ ...SUMMARY, city: null }} href="/listing/a-listing" labels={LABELS} />,
    );
    expect(html).not.toContain('Cairo');
  });

  it('carries nothing beyond the approved card fields', () => {
    const html = renderToStaticMarkup(
      <ListingCard listing={SUMMARY} href="/listing/a-listing" labels={LABELS} />,
    );
    // The internal listing type code is not printed, and neither is anything else 6-J did not approve.
    expect(html).not.toContain('product');
    expect(html).not.toContain('250000');
  });

  /**
   * Narrowed by 0101: the card now carries its listing identifier in one data attribute so a single
   * capture handler can tell which card was clicked (`ListingClickBeacon`). The identifier is the public
   * catalogue key the beacon contract already names, and the invariant it replaces still holds — it is a
   * machine-readable attribute, never visible text, and it is the only identifier in the markup.
   */
  it('carries its listing identifier only as the beacon attribute, never as text', () => {
    const html = renderToStaticMarkup(
      <ListingCard listing={SUMMARY} href="/listing/a-listing" labels={LABELS} />,
    );
    expect(html).toContain(`data-listing-id="${SUMMARY.id}"`);
    expect(html.split(SUMMARY.id)).toHaveLength(2);
    expect(html.replace(`data-listing-id="${SUMMARY.id}"`, '')).not.toContain(SUMMARY.id);
    expect(html).not.toContain(`>${SUMMARY.id}`);
  });
});

describe('the browse list', () => {
  it('renders one item per listing in the order it was given', () => {
    const listings = [SUMMARY, { ...SUMMARY, id: '2', slug: 'second', title: 'Second listing' }];
    const html = renderToStaticMarkup(
      <ListingGrid listings={listings} hrefFor={(slug) => `/listing/${slug}`} labels={LABELS} />,
    );
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html.indexOf('A listing title')).toBeLessThan(html.indexOf('Second listing'));
  });

  it('uses a list, so a screen reader is told how many listings there are', () => {
    const html = renderToStaticMarkup(
      <ListingGrid listings={[SUMMARY]} hrefFor={() => '/listing/a-listing'} labels={LABELS} />,
    );
    expect(html).toContain('<ul');
    expect(html).toContain('<li');
  });

  it('styles with logical properties only, so the same markup reads right-to-left', () => {
    const html = renderToStaticMarkup(
      <ListingGrid listings={[SUMMARY]} hrefFor={() => '/listing/a-listing'} labels={LABELS} />,
    );
    for (const physical of ['text-left', 'text-right', 'ml-', 'mr-', 'pl-', 'pr-', 'left-', 'right-']) {
      expect(html).not.toContain(`"${physical}`);
      expect(html).not.toContain(` ${physical}`);
    }
  });
});

describe('the loading, empty and error states', () => {
  it('announces the wait and hides the placeholder boxes from assistive technology', () => {
    const html = renderToStaticMarkup(<ListingGridSkeleton label={EN.loading} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(EN.loading);
    expect(html).toContain('aria-hidden="true"');
  });

  it('treats an empty catalogue as a status and a failure as an alert', () => {
    const empty = renderToStaticMarkup(
      <ListingMessage tone="empty" title={EN.emptyTitle} description={EN.emptyDescription} />,
    );
    expect(empty).toContain('role="status"');
    expect(empty).toContain(EN.emptyTitle);

    const error = renderToStaticMarkup(
      <ListingMessage tone="error" title={EN.errorTitle} description={EN.errorDescription} />,
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain(EN.errorTitle);
  });
});

describe('the listing detail', () => {
  it('renders the approved projection', () => {
    const html = renderToStaticMarkup(<ListingDetailView listing={DETAIL} labels={LABELS} />);
    for (const expected of [
      'A listing title',
      'Cairo',
      'EGP 2500.00',
      'A description long enough to be real.',
      'Furniture',
      'Good Shop',
      'Handmade',
      'Width',
      '180 cm',
      EN.yes,
      'Red, Blue',
    ]) {
      // Against the rendered text, not the markup: a price is a composed figure and is split across elements.
      expect(textOf(html), expected).toContain(expected);
    }
  });

  it('marks the seller content with its own language, not the page language', () => {
    const html = renderToStaticMarkup(<ListingDetailView listing={DETAIL} labels={LABELS} />);
    expect(html).toContain('lang="ar"');
  });

  it('shows the availability marker only when the listing is no longer available', () => {
    const available = renderToStaticMarkup(<ListingDetailView listing={DETAIL} labels={LABELS} />);
    expect(available).not.toContain(EN.noLongerAvailable);

    const gone = renderToStaticMarkup(
      <ListingDetailView listing={{ ...DETAIL, availability: 'no_longer_available' }} labels={LABELS} />,
    );
    expect(gone).toContain(EN.noLongerAvailable);
    expect(gone).toContain('A listing title');
  });

  it('exactly one h1, and headings for each section', () => {
    const html = renderToStaticMarkup(<ListingDetailView listing={DETAIL} labels={LABELS} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    for (const heading of [EN.descriptionHeading, EN.detailsHeading, EN.sellerHeading, EN.categoryHeading, EN.tagsHeading]) {
      expect(html).toContain(heading);
    }
  });

  it('omits an empty section rather than rendering a heading with nothing under it', () => {
    const bare = { ...DETAIL, attributes: [], tags: [] };
    const html = renderToStaticMarkup(<ListingDetailView listing={bare} labels={LABELS} />);
    expect(html).not.toContain(EN.detailsHeading);
    expect(html).not.toContain(EN.tagsHeading);
  });

  it('cannot print a seller identifier, contact detail or location even if one is handed to it', () => {
    const smuggled = {
      ...DETAIL,
      sellerUserId: '99999999-9999-4999-8999-999999999999',
      contactEmail: 'seller@example.com',
      contactPhoneE164: '+201000000000',
      legalName: 'Good Shop LLC',
      viewCount: 412,
      location: 'POINT(31.2 30.0)',
    } as unknown as ListingDetail;
    const html = renderToStaticMarkup(<ListingDetailView listing={smuggled} labels={LABELS} />);
    for (const secret of [
      '99999999-9999-4999-8999-999999999999',
      'seller@example.com',
      '+201000000000',
      'Good Shop LLC',
      '412',
      'POINT',
    ]) {
      expect(html).not.toContain(secret);
    }
    expect(html).toContain('Good Shop');
  });
});

describe('the listings copy', () => {
  it('carries the same keys in both languages', () => {
    expect(Object.keys(AR).sort()).toEqual(Object.keys(EN).sort());
  });

  it('is actually translated, not the English left in place', () => {
    for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
      expect(AR[key]).not.toBe(EN[key]);
      expect(AR[key].trim()).not.toBe('');
    }
  });
});
