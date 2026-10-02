import type { CategoryNode } from '@repo/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import {
  CategoryTree,
  CategoryTreeMessage,
  CategoryTreeSkeleton,
} from '../src/components/category-tree';

/**
 * The category tree as markup (Phase 4-A).
 *
 * Three things are worth pinning: the structure a screen reader walks (headings with labelled lists),
 * the absence of anything the page has no right to show (links to pages that do not exist, or fields the
 * contract does not carry), and direction-neutral styling, because the same markup has to read
 * correctly in Arabic.
 */

const node = (id: string, name: string, children: CategoryNode[] = []): CategoryNode => ({
  id,
  slug: name.toLowerCase(),
  name,
  children,
});

const TREE: readonly CategoryNode[] = [
  node('11111111-1111-4111-8111-111111111111', 'Electronics', [
    node('22222222-2222-4222-8222-222222222222', 'Phones', [
      node('33333333-3333-4333-8333-333333333333', 'Smartphones'),
    ]),
  ]),
  node('44444444-4444-4444-8444-444444444444', 'Home'),
];

describe('the category tree', () => {
  it('renders every level of the tree', () => {
    const html = renderToStaticMarkup(<CategoryTree nodes={TREE} />);
    for (const name of ['Electronics', 'Phones', 'Smartphones', 'Home']) {
      expect(html).toContain(name);
    }
  });

  it('gives each top-level category a heading and labels its list with it', () => {
    const html = renderToStaticMarkup(<CategoryTree nodes={TREE} />);
    expect(html).toContain('id="category-11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('aria-labelledby="category-11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('<h2');
  });

  it('renders no list at all for a category with no children', () => {
    const html = renderToStaticMarkup(<CategoryTree nodes={[node('44444444-4444-4444-8444-444444444444', 'Home')]} />);
    expect(html).not.toContain('<ul');
  });

  it('links nowhere: there is no listing page to link to yet', () => {
    const html = renderToStaticMarkup(<CategoryTree nodes={TREE} />);
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
  });

  it('uses logical spacing so the same markup reads right-to-left', () => {
    const html = renderToStaticMarkup(<CategoryTree nodes={TREE} />);
    // Start/end utilities, never left/right ones.
    expect(html).toMatch(/\bps-4\b/);
    expect(html).toMatch(/\bborder-s\b/);
    expect(html).not.toMatch(/\bpl-\d/);
    expect(html).not.toMatch(/\bpr-\d/);
    expect(html).not.toMatch(/\bborder-l\b/);
    expect(html).not.toMatch(/\bborder-r\b/);
    expect(html).not.toContain('text-left');
    expect(html).not.toContain('text-right');
  });

  it('reflows from one column to three without losing structure', () => {
    const html = renderToStaticMarkup(<CategoryTree nodes={TREE} />);
    expect(html).toContain('grid-cols-1');
    expect(html).toContain('sm:grid-cols-2');
    expect(html).toContain('lg:grid-cols-3');
  });

  it('shows nothing but the four contract fields', () => {
    const html = renderToStaticMarkup(<CategoryTree nodes={TREE} />);
    // The slug and the identifier are plumbing; only the name is content.
    expect(html).not.toContain('electronics');
    expect(html).not.toContain('smartphones');
  });
});

describe('the loading state', () => {
  it('announces itself and hides its placeholders from assistive technology', () => {
    const html = renderToStaticMarkup(<CategoryTreeSkeleton label={en.Categories.loading} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(en.Categories.loading);
  });
});

describe('the empty and error states', () => {
  it('announces an empty catalogue politely', () => {
    const html = renderToStaticMarkup(
      <CategoryTreeMessage
        tone="empty"
        title={en.Categories.emptyTitle}
        description={en.Categories.emptyDescription}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain(en.Categories.emptyTitle);
  });

  it('announces a failure as an alert', () => {
    const html = renderToStaticMarkup(
      <CategoryTreeMessage
        tone="error"
        title={en.Categories.errorTitle}
        description={en.Categories.errorDescription}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(en.Categories.errorTitle);
  });

  it('offers no action, because the page has none to offer', () => {
    const html = renderToStaticMarkup(
      <CategoryTreeMessage tone="error" title="t" description="d" />,
    );
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  });
});

describe('the category messages', () => {
  it('exists in both locales with the same keys', () => {
    expect(Object.keys(en.Categories).sort()).toEqual(Object.keys(ar.Categories).sort());
  });

  it('is actually translated, not copied', () => {
    for (const key of Object.keys(en.Categories) as Array<keyof typeof en.Categories>) {
      expect(ar.Categories[key]).not.toBe(en.Categories[key]);
      expect(ar.Categories[key].length).toBeGreaterThan(0);
    }
  });

  it('carries Arabic script in the Arabic catalogue', () => {
    for (const value of Object.values(ar.Categories)) {
      expect(value).toMatch(/[؀-ۿ]/);
    }
  });
});
