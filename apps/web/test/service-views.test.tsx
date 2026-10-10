import type { ServiceDetail, ServiceSummary } from '@repo/contracts';
import { createTranslator } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import {


  ServiceCard,
  ServiceDetailView,
  ServiceGrid,
  ServiceGridSkeleton,
} from '../src/components/service-views';

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
 * The public service surfaces as markup (Phase 4-C).
 *
 * Three things are worth pinning. The service-specific facts, because they are the whole reason services
 * have a surface of their own. The pluralized delivery time in both languages, since Arabic has plural
 * categories English does not and getting them wrong is the kind of thing nobody reports. And, above all,
 * the absence of anything the page has no right to show.
 */

const EN = en.Services;
const AR = ar.Services;

/** The real translator, so the plural rules under test are the ones the pages will use. */
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'Services' });
const tAr = createTranslator({ locale: 'ar', messages: ar, namespace: 'Services' });

const LABELS = {
  contactForPrice: EN.contactForPrice,
  negotiable: '',
  fixedPrice: EN.fixedPrice,
  customPricing: EN.customPricing,
  deliveryTime: EN.deliveryTime,
  revisionsIncluded: EN.revisionsIncluded,
  deliveryDays: (count: number) => tEn('deliveryDays', { count }),
  noLongerAvailable: EN.noLongerAvailable,
  requiresBrief: EN.requiresBrief,
  scope: EN.scope,
  sellerHeading: EN.sellerHeading,
  categoryHeading: EN.categoryHeading,
  detailsHeading: EN.detailsHeading,
  tagsHeading: EN.tagsHeading,
  descriptionHeading: EN.descriptionHeading,
  yes: EN.yes,
  no: EN.no,
} as const;

const SUMMARY: ServiceSummary = {
  id: '22220000-0000-4000-8000-000000000001',
  slug: 'logo-design',
  title: 'Logo design',
  city: 'Cairo',
  priceMinor: '150000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  pricingModel: 'fixed',
  deliveryDays: 5,
  revisionsIncluded: 2,
};

const DETAIL: ServiceDetail = {
  ...SUMMARY,
  description: 'A description long enough to be real.',
  contentLanguage: 'ar',
  requiresBrief: true,
  scope: 'Three concepts, two rounds of revision.',
  availability: 'available',
  category: { slug: 'design', name: 'Design' },
  seller: { slug: 'good-shop', displayName: 'Good Shop' },
  attributes: [
    { key: 'turnaround', label: 'Turnaround', unit: 'h', kind: 'number', text: '48', boolean: null, options: [] },
  ],
  tags: [{ slug: 'remote', name: 'Remote' }],
};

describe('the delivery time', () => {
  it('uses the singular and the plural in English', () => {
    expect(tEn('deliveryDays', { count: 1 })).toBe('1 day');
    expect(tEn('deliveryDays', { count: 2 })).toBe('2 days');
    expect(tEn('deliveryDays', { count: 30 })).toBe('30 days');
  });

  it('uses the right plural category in Arabic', () => {
    // Arabic distinguishes one, two, few (3–10), many (11–99) and other; the owner supplied a form for
    // each of the ones that carry different wording.
    expect(tAr('deliveryDays', { count: 1 })).toBe('يوم واحد');
    expect(tAr('deliveryDays', { count: 2 })).toBe('يومان');
    expect(tAr('deliveryDays', { count: 5 })).toBe('5 أيام');
    expect(tAr('deliveryDays', { count: 30 })).toBe('30 يومًا');
  });
});

describe('a service card', () => {
  it('shows the title, city, price and the service facts', () => {
    const html = renderToStaticMarkup(
      <ServiceCard service={SUMMARY} href="/service/logo-design" labels={LABELS} />,
    );
    expect(html).toContain('Logo design');
    expect(html).toContain('Cairo');
    expect(textOf(html)).toContain('EGP 1500.00');
    expect(html).toContain(EN.fixedPrice);
    expect(html).toContain('5 days');
    expect(html).toContain(EN.revisionsIncluded);
    expect(html).toContain('href="/service/logo-design"');
  });

  it('says "contact for price" when the service carries no amount', () => {
    const custom = { ...SUMMARY, priceMinor: null, pricingModel: 'custom' as const, deliveryDays: null };
    const html = renderToStaticMarkup(
      <ServiceCard service={custom} href="/service/x" labels={LABELS} />,
    );
    expect(html).toContain(EN.contactForPrice);
    expect(html).toContain(EN.customPricing);
    expect(html).not.toContain('EGP');
  });

  it('omits a fact the service does not state rather than inventing one', () => {
    const bare = {
      ...SUMMARY,
      pricingModel: null,
      deliveryDays: null,
      revisionsIncluded: null,
    };
    const html = renderToStaticMarkup(<ServiceCard service={bare} href="/service/x" labels={LABELS} />);
    expect(html).not.toContain(EN.deliveryTime);
    expect(html).not.toContain(EN.revisionsIncluded);
    expect(html).not.toContain(EN.fixedPrice);
    expect(html).not.toContain(EN.customPricing);
  });

  it('carries nothing beyond the approved card', () => {
    const html = renderToStaticMarkup(
      <ServiceCard service={SUMMARY} href="/service/logo-design" labels={LABELS} />,
    );
    expect(html).not.toContain(SUMMARY.id);
  });
});

describe('the service list', () => {
  it('renders one item per service in the order it was given', () => {
    const services = [SUMMARY, { ...SUMMARY, id: '2', slug: 'brand-audit', title: 'Brand audit' }];
    const html = renderToStaticMarkup(
      <ServiceGrid services={services} hrefFor={(slug) => `/service/${slug}`} labels={LABELS} />,
    );
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html.indexOf('Logo design')).toBeLessThan(html.indexOf('Brand audit'));
  });

  it('styles with logical properties only, so the same markup reads right-to-left', () => {
    const html = renderToStaticMarkup(
      <ServiceGrid services={[SUMMARY]} hrefFor={() => '/service/logo-design'} labels={LABELS} />,
    );
    for (const physical of ['text-left', 'text-right', 'ml-', 'mr-', 'pl-', 'pr-', 'left-', 'right-']) {
      expect(html).not.toContain(`"${physical}`);
      expect(html).not.toContain(` ${physical}`);
    }
  });

  it('announces the wait and hides the placeholders from assistive technology', () => {
    const html = renderToStaticMarkup(<ServiceGridSkeleton label={EN.loading} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(EN.loading);
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('the service detail', () => {
  it('renders the approved projection', () => {
    const html = renderToStaticMarkup(<ServiceDetailView service={DETAIL} labels={LABELS} />);
    for (const expected of [
      'Logo design',
      'Cairo',
      'EGP 1500.00',
      'A description long enough to be real.',
      'Three concepts, two rounds of revision.',
      EN.scope,
      EN.requiresBrief,
      EN.deliveryTime,
      '5 days',
      'Design',
      'Good Shop',
      'Remote',
      'Turnaround',
      '48 h',
    ]) {
      // Against the rendered text, not the markup: a price is a composed figure and is split across elements.
      expect(textOf(html), expected).toContain(expected);
    }
  });

  it('marks the seller content with its own language, not the page language', () => {
    const html = renderToStaticMarkup(<ServiceDetailView service={DETAIL} labels={LABELS} />);
    expect(html).toContain('lang="ar"');
  });

  it('shows the availability marker only when the service is no longer available', () => {
    const available = renderToStaticMarkup(<ServiceDetailView service={DETAIL} labels={LABELS} />);
    expect(available).not.toContain(EN.noLongerAvailable);

    const gone = renderToStaticMarkup(
      <ServiceDetailView service={{ ...DETAIL, availability: 'no_longer_available' }} labels={LABELS} />,
    );
    expect(gone).toContain(EN.noLongerAvailable);
    expect(gone).toContain('Logo design');
  });

  it('has exactly one h1', () => {
    const html = renderToStaticMarkup(<ServiceDetailView service={DETAIL} labels={LABELS} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it('omits an empty section rather than rendering a heading with nothing under it', () => {
    const bare = { ...DETAIL, attributes: [], tags: [], scope: null, requiresBrief: null };
    const html = renderToStaticMarkup(<ServiceDetailView service={bare} labels={LABELS} />);
    expect(html).not.toContain(EN.detailsHeading);
    expect(html).not.toContain(EN.tagsHeading);
    expect(html).not.toContain(EN.scope);
    expect(html).not.toContain(EN.requiresBrief);
  });

  it('cannot print a seller identifier, contact detail or location even if one is handed to it', () => {
    const smuggled = {
      ...DETAIL,
      sellerUserId: '99999999-9999-4999-8999-999999999999',
      contactEmail: 'seller@example.com',
      contactPhoneE164: '+201000000000',
      legalName: 'Good Shop LLC',
      verificationStatus: 'verified',
      location: 'POINT(31.2 30.0)',
    } as unknown as ServiceDetail;
    const html = renderToStaticMarkup(<ServiceDetailView service={smuggled} labels={LABELS} />);
    for (const secret of [
      '99999999-9999-4999-8999-999999999999',
      'seller@example.com',
      '+201000000000',
      'Good Shop LLC',
      'POINT',
    ]) {
      expect(html, secret).not.toContain(secret);
    }
    expect(html).toContain('Good Shop');
  });
});

describe('the services copy', () => {
  it('carries the same keys in both languages', () => {
    expect(Object.keys(AR).sort()).toEqual(Object.keys(EN).sort());
  });

  it('is actually translated, not the English left in place', () => {
    for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
      expect(AR[key], key).not.toBe(EN[key]);
      expect(AR[key].trim(), key).not.toBe('');
    }
  });
});
