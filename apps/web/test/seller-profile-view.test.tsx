import type { PublicSellerProfile } from '@repo/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { SellerProfileView } from '../src/components/seller-profile';

/**
 * The public seller profile as markup (Phase 4-E).
 *
 * A profile and nothing else: the assertions are about what appears, what is left out when a seller did
 * not fill it in, and — above all — that nothing the owner excluded can reach the page even if handed to
 * the component directly.
 */

const EN = en.Sellers;
const AR = ar.Sellers;

const LABELS = { unavailable: EN.unavailable, noDescription: EN.noDescription } as const;

const SELLER: PublicSellerProfile = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  bio: 'We restore mid-century furniture.',
  contentLanguage: 'en',
  city: 'Cairo',
};

describe('an active seller profile', () => {
  it('shows the name as the page heading, once', () => {
    const html = renderToStaticMarkup(
      <SellerProfileView seller={SELLER} availability="available" labels={LABELS} />,
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('Good Shop');
  });

  it('shows the bio and the city', () => {
    const html = renderToStaticMarkup(
      <SellerProfileView seller={SELLER} availability="available" labels={LABELS} />,
    );
    expect(html).toContain('We restore mid-century furniture.');
    expect(html).toContain('Cairo');
  });

  it('marks the bio with the language it was written in', () => {
    const arabicBio = { ...SELLER, bio: 'نصنع الأثاث يدويًا.', contentLanguage: 'ar' };
    const html = renderToStaticMarkup(
      <SellerProfileView seller={arabicBio} availability="available" labels={LABELS} />,
    );
    expect(html).toContain('lang="ar"');
  });

  it('omits the language attribute when the seller recorded none', () => {
    const noLanguage = { ...SELLER, contentLanguage: null };
    const html = renderToStaticMarkup(
      <SellerProfileView seller={noLanguage} availability="available" labels={LABELS} />,
    );
    expect(html).not.toContain('lang=');
    expect(html).toContain('We restore mid-century furniture.');
  });

  it('shows no availability notice', () => {
    const html = renderToStaticMarkup(
      <SellerProfileView seller={SELLER} availability="available" labels={LABELS} />,
    );
    expect(html).not.toContain(EN.unavailable);
  });
});

describe('a seller with nothing optional filled in', () => {
  it('says there is no description, and omits the city line entirely', () => {
    const bare = { ...SELLER, bio: null, contentLanguage: null, city: null };
    const html = renderToStaticMarkup(
      <SellerProfileView seller={bare} availability="available" labels={LABELS} />,
    );
    expect(html).toContain(EN.noDescription);
    expect(html).not.toContain('Cairo');
    expect(html).toContain('Good Shop');
  });
});

describe('a suspended seller profile', () => {
  it('announces the unavailability as a status, and still names the seller', () => {
    const html = renderToStaticMarkup(
      <SellerProfileView seller={SELLER} availability="unavailable" labels={LABELS} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain(EN.unavailable);
    expect(html).toContain('Good Shop');
  });
});

describe('what the profile must never carry', () => {
  it('cannot print a private field even if one is handed to it', () => {
    const smuggled = {
      ...SELLER,
      legalName: 'Good Shop LLC',
      contactEmail: 'good@example.com',
      contactPhoneE164: '+201000000001',
      verificationStatus: 'verified',
      suspensionReason: 'Repeated policy breaches',
      countryCode: 'EG',
      governorate: 'Cairo Governorate',
    } as unknown as PublicSellerProfile;
    const html = renderToStaticMarkup(
      <SellerProfileView seller={smuggled} availability="available" labels={LABELS} />,
    );
    for (const secret of [
      'Good Shop LLC',
      'good@example.com',
      '+201000000001',
      'verified',
      'Repeated policy breaches',
      'Cairo Governorate',
    ]) {
      expect(html, secret).not.toContain(secret);
    }
    expect(html).toContain('Good Shop');
  });

  it('has no listing, service, rating or verification UI', () => {
    const html = renderToStaticMarkup(
      <SellerProfileView seller={SELLER} availability="available" labels={LABELS} />,
    );
    for (const term of ['EGP', 'Contact for price', 'Show more', 'Reviews', 'Verified', 'Rating']) {
      expect(html, term).not.toContain(term);
    }
  });

  it('styles with logical properties only, so the same markup reads right-to-left', () => {
    const html = renderToStaticMarkup(
      <SellerProfileView seller={SELLER} availability="unavailable" labels={LABELS} />,
    );
    for (const physical of ['text-left', 'text-right', 'ml-', 'mr-', 'pl-', 'pr-', 'left-', 'right-']) {
      expect(html).not.toContain(`"${physical}`);
      expect(html).not.toContain(` ${physical}`);
    }
  });
});

describe('the seller copy', () => {
  it('carries the same keys in both languages', () => {
    expect(Object.keys(AR).sort()).toEqual(Object.keys(EN).sort());
  });

  it('is actually translated, not the English left in place', () => {
    for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
      expect(AR[key], key).not.toBe(EN[key]);
      expect(AR[key].trim(), key).not.toBe('');
    }
  });

  it('uses the owner-approved wording', () => {
    expect(EN.title).toBe('Seller');
    expect(EN.unavailable).toBe('This seller is currently unavailable.');
    expect(EN.noDescription).toBe('No seller description is available.');
    expect(EN.error).toBe("We couldn't load this seller profile.");
    expect(AR.title).toBe('البائع');
    expect(AR.unavailable).toBe('هذا البائع غير متاح حاليًا.');
    expect(AR.noDescription).toBe('لا يتوفر وصف لهذا البائع.');
    expect(AR.error).toBe('تعذر تحميل ملف البائع هذا.');
  });
});
