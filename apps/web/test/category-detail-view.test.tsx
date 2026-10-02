import type { CategoryDetail } from '@repo/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { CategoryDetailView } from '../src/components/category-detail';

/**
 * The category landing page's body as markup (Phase 4-D).
 *
 * A category page in V1 is a place, not a feed. The assertions are about what it shows (a heading, the
 * admin's description, the way further in), what it does not (any listing, service, count or filter),
 * and that it reads correctly right-to-left.
 */

const EN = en.Categories;
const AR = ar.Categories;

const LABELS = {
  subcategoriesHeading: EN.subcategoriesHeading,
  emptyChildrenTitle: EN.emptyChildrenTitle,
  emptyChildren: EN.emptyChildren,
  parentHeading: EN.parentHeading,
} as const;

const CATEGORY: CategoryDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'furniture',
  name: 'Furniture',
  description: 'Everything for the home.',
  parent: null,
  children: [
    { id: '22222222-2222-4222-8222-222222222222', slug: 'seating', name: 'Seating' },
    { id: '33333333-3333-4333-8333-333333333333', slug: 'tables', name: 'Tables' },
  ],
};

const href = (slug: string) => `/category/${slug}`;

describe('the category landing view', () => {
  it('renders the name as the page heading, once', () => {
    const html = renderToStaticMarkup(
      <CategoryDetailView category={CATEGORY} hrefFor={href} labels={LABELS} />,
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('Furniture');
  });

  it('shows the description when there is one and nothing when there is not', () => {
    const withText = renderToStaticMarkup(
      <CategoryDetailView category={CATEGORY} hrefFor={href} labels={LABELS} />,
    );
    expect(withText).toContain('Everything for the home.');

    const without = renderToStaticMarkup(
      <CategoryDetailView category={{ ...CATEGORY, description: null }} hrefFor={href} labels={LABELS} />,
    );
    expect(without).not.toContain('Everything for the home.');
  });

  it('lists the children as links, in the order given, in a labelled list', () => {
    const html = renderToStaticMarkup(
      <CategoryDetailView category={CATEGORY} hrefFor={href} labels={LABELS} />,
    );
    expect(html).toContain('href="/category/seating"');
    expect(html).toContain('href="/category/tables"');
    expect(html.indexOf('Seating')).toBeLessThan(html.indexOf('Tables'));
    expect(html).toContain('<ul');
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it('names the parent as a link only when there is one', () => {
    const root = renderToStaticMarkup(
      <CategoryDetailView category={CATEGORY} hrefFor={href} labels={LABELS} />,
    );
    expect(root).not.toContain(EN.parentHeading);

    const child = renderToStaticMarkup(
      <CategoryDetailView
        category={{ ...CATEGORY, parent: { id: 'p', slug: 'home', name: 'Home' } }}
        hrefFor={href}
        labels={LABELS}
      />,
    );
    expect(child).toContain(EN.parentHeading);
    expect(child).toContain('href="/category/home"');
  });

  it('announces an empty child list as a status rather than an error', () => {
    const html = renderToStaticMarkup(
      <CategoryDetailView category={{ ...CATEGORY, children: [] }} hrefFor={href} labels={LABELS} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain(EN.emptyChildren);
    expect(html).not.toContain('<li');
  });

  it('carries no listing feed, count, filter or sort', () => {
    const html = renderToStaticMarkup(
      <CategoryDetailView category={CATEGORY} hrefFor={href} labels={LABELS} />,
    );
    for (const term of ['EGP', 'Contact for price', 'Show more', 'cursor', 'Sort', 'Filter']) {
      expect(html, term).not.toContain(term);
    }
  });

  it('cannot print a private field even if one is handed to it', () => {
    const smuggled = {
      ...CATEGORY,
      isActive: true,
      listingTypeCode: 'product',
      listingCount: 42,
      imageObjectPath: 'categories/furniture.png',
    } as unknown as CategoryDetail;
    const html = renderToStaticMarkup(
      <CategoryDetailView category={smuggled} hrefFor={href} labels={LABELS} />,
    );
    for (const secret of ['product', '42', 'categories/furniture.png']) {
      expect(html, secret).not.toContain(secret);
    }
  });

  it('styles with logical properties only, so the same markup reads right-to-left', () => {
    const html = renderToStaticMarkup(
      <CategoryDetailView category={CATEGORY} hrefFor={href} labels={LABELS} />,
    );
    for (const physical of ['text-left', 'text-right', 'ml-', 'mr-', 'pl-', 'pr-', 'left-', 'right-']) {
      expect(html).not.toContain(`"${physical}`);
      expect(html).not.toContain(` ${physical}`);
    }
  });
});

describe('the category copy', () => {
  it('carries the same keys in both languages', () => {
    expect(Object.keys(AR).sort()).toEqual(Object.keys(EN).sort());
  });

  it('is actually translated, not the English left in place', () => {
    for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
      expect(AR[key], key).not.toBe(EN[key]);
      expect(AR[key].trim(), key).not.toBe('');
    }
  });

  it('uses the owner-approved empty and error wording', () => {
    expect(EN.emptyChildren).toBe('No subcategories are available.');
    expect(EN.categoryError).toBe("We couldn't load this category.");
    expect(AR.emptyChildren).toBe('لا توجد فئات فرعية متاحة.');
    expect(AR.categoryError).toBe('تعذر تحميل هذه الفئة.');
  });
});
