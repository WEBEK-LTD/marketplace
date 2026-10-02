import { describe, expect, it } from 'vitest';
import {
  CategoryDetailResponseSchema,
  CategoryDetailSchema,
  PublicCategoryResponseSchema,
} from '../src/index.js';

/**
 * The public category detail contract (Phase 4-D).
 *
 * Two shapes on purpose: the internal API response carries the document-head fields, and the
 * browser-facing one does not. The tests that matter are the refusals — a field nobody approved, a
 * recursive child, and `seo` reaching a browser.
 */

const LINK = { id: '11111111-1111-4111-8111-111111111111', slug: 'seating', name: 'Seating' } as const;

const CATEGORY = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'furniture',
  name: 'Furniture',
  description: 'Everything for the home.',
  parent: null,
  children: [LINK],
} as const;

const SEO = { metaTitle: 'Furniture | Marketplace', metaDescription: 'Browse furniture.' } as const;

describe('a category detail', () => {
  it('accepts the approved projection', () => {
    expect(CategoryDetailSchema.safeParse(CATEGORY).success).toBe(true);
  });

  it('allows a root with no parent, no description and no children', () => {
    const bare = { ...CATEGORY, description: null, parent: null, children: [] };
    expect(CategoryDetailSchema.safeParse(bare).success).toBe(true);
  });

  it('allows a child that names its parent', () => {
    expect(CategoryDetailSchema.safeParse({ ...CATEGORY, parent: LINK }).success).toBe(true);
  });

  it('refuses every field the owner excluded', () => {
    for (const extra of [
      { listingTypeCode: 'product' },
      { listingCount: 12 },
      { isActive: true },
      { sortOrder: 1 },
      { depth: 0 },
      { icon: 'chair' },
      { imageObjectPath: 'categories/furniture.png' },
      { createdAt: '2026-01-01T12:00:00.000Z' },
      { metaTitle: 'Furniture' },
      { metaDescription: 'Browse furniture.' },
    ]) {
      expect(CategoryDetailSchema.safeParse({ ...CATEGORY, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
  });

  it('keeps parent and child links to three fields', () => {
    for (const extra of [{ children: [] }, { listingCount: 3 }, { isActive: true }, { parentId: null }]) {
      expect(
        CategoryDetailSchema.safeParse({ ...CATEGORY, children: [{ ...LINK, ...extra }] }).success,
        Object.keys(extra)[0],
      ).toBe(false);
    }
  });

  it('does not nest: a landing page is one step in each direction', () => {
    const nested = { ...CATEGORY, children: [{ ...LINK, children: [] }] };
    expect(CategoryDetailSchema.safeParse(nested).success).toBe(false);
  });
});

describe('the two response shapes', () => {
  it('the internal response carries the document-head fields', () => {
    expect(CategoryDetailResponseSchema.safeParse({ category: CATEGORY, seo: SEO }).success).toBe(true);
    expect(CategoryDetailResponseSchema.safeParse({ category: CATEGORY }).success).toBe(false);
  });

  it('a null meta title or description is allowed', () => {
    const empty = { metaTitle: null, metaDescription: null };
    expect(CategoryDetailResponseSchema.safeParse({ category: CATEGORY, seo: empty }).success).toBe(true);
  });

  it('the browser-facing response has no seo key at all', () => {
    expect(PublicCategoryResponseSchema.safeParse({ category: CATEGORY }).success).toBe(true);
    // The whole point of the split: head fields cannot reach a browser through this document.
    expect(PublicCategoryResponseSchema.safeParse({ category: CATEGORY, seo: SEO }).success).toBe(false);
  });
});
