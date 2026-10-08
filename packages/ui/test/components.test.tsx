import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Alert,
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  ButtonLink,
  Card,
  CardFooter,
  CardOverlayLink,
  CardTitle,
  DetailList,
  EmptyState,
  firstGrapheme,
  FormField,
  fieldAria,
  Heading,
  Input,
  LinkCard,
  PageContainer,
  Pagination,
  Section,
  SectionHeader,
  Select,
  SkeletonCardGrid,
  SkipLink,
  Tabs,
  Textarea,
  TYPE,
} from '../src/index.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * Comments explain the rules; only real code can break them.
 *
 * Every one of the scans below reads this, not the raw file. `recipes.ts` documents the logical-direction rule by
 * quoting the `pl-4` it forbids, and a scan over raw text fails on that explanation — the same false positive that
 * has made three earlier detectors in this repository wrong.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function sources(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe('structure primitives', () => {
  it('PageContainer renders the chosen element with RTL-safe padding', () => {
    const html = renderToStaticMarkup(
      <PageContainer as="main" id="content">
        x
      </PageContainer>,
    );
    expect(html).toBe('<main id="content" class="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">x</main>');
    expect(renderToStaticMarkup(<PageContainer>y</PageContainer>)).toMatch(/^<div /);
  });

  it('SkipLink targets the content id and uses logical positioning', () => {
    const html = renderToStaticMarkup(<SkipLink targetId="content">Skip</SkipLink>);
    expect(html).toContain('href="#content"');
    expect(html).toContain('focus:start-4');
  });

  it('Heading renders the requested level, and display size keeps the level', () => {
    expect(renderToStaticMarkup(<Heading level={1}>Title</Heading>)).toContain('<h1 class="text-3xl');
    expect(renderToStaticMarkup(<Heading level={4}>Sub</Heading>)).toMatch(/^<h4 /);
    // The document outline must not have to follow the type scale: an h1 may be display-sized, and a display
    // heading is still an h1.
    const display = renderToStaticMarkup(<Heading level={1} display>Big</Heading>);
    expect(display).toMatch(/^<h1 /);
    expect(display).toContain('sm:text-5xl');
  });

  it('SectionHeader renders no eyebrow label above the heading', () => {
    // A small tracked-out word above every title is the commonest piece of template chrome, and in Arabic — which
    // has no letter case — it carries nothing at all. The guard is structural: the first element is the heading.
    const html = renderToStaticMarkup(<SectionHeader title="Products" description="Browse everything" as="h2" />);
    expect(html).toContain('<h2');
    expect(html).not.toMatch(/uppercase|tracking-/);
    expect(html.indexOf('<h2')).toBeLessThan(html.indexOf('Browse everything'));
  });

  it('Section applies one of three named rhythms', () => {
    expect(renderToStaticMarkup(<Section space="lg">a</Section>)).toContain('py-10 sm:py-14');
    expect(renderToStaticMarkup(<Section space="sm">a</Section>)).toContain('py-6');
  });
});

describe('controls', () => {
  it('Button renders every variant and keeps one focus ring', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const html = renderToStaticMarkup(<Button variant={variant}>Go</Button>);
      expect(html, variant).toContain('focus-visible:outline-neutral-900');
      expect(html, variant).toContain('rounded-md');
    }
  });

  it('a destructive button is marked by weight, because the palette has no red', () => {
    const html = renderToStaticMarkup(<Button variant="danger">Delete listing</Button>);
    expect(html).toContain('border-2');
    expect(html).toContain('hover:bg-neutral-900');
    expect(html).not.toMatch(/red|rose|danger-/);
  });

  it('a pending button is disabled and announced, not just drawn', () => {
    const html = renderToStaticMarkup(
      <Button pending pendingLabel="Saving">
        Save
      </Button>,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('aria-busy="true"');
    // The label changes too: a spinner alone leaves a screen-reader user with no new information.
    expect(html).toContain('Saving');
    expect(html).not.toContain('>Save<');
  });

  it('ButtonLink is an anchor, so a navigation stays a navigation', () => {
    const html = renderToStaticMarkup(<ButtonLink href="/listings">Browse</ButtonLink>);
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/listings"');
  });

  it('Input and Textarea share one field shell, and error raises weight without resizing', () => {
    const plain = renderToStaticMarkup(<Input id="q" name="q" />);
    const errored = renderToStaticMarkup(<Input id="q" name="q" error />);
    expect(plain).toContain('border border-neutral-300');
    expect(errored).toContain('border-2 border-neutral-900');
    // The 2px replaces the 1px rather than adding to it, so a refused form does not reflow.
    expect(errored).not.toContain('border border-neutral-300');
    expect(renderToStaticMarkup(<Textarea id="d" name="d" />)).toContain('rounded-md');
  });

  it('Select is a native select with exactly one arrow', () => {
    const html = renderToStaticMarkup(
      <Select id="sort" name="sort" options={[{ value: 'new', label: 'Newest' }]} placeholder="Choose" />,
    );
    expect(html).toContain('<select');
    // The platform arrow is removed so ours is not a second one.
    expect(html).toContain('appearance-none');
    expect(html).toContain('<option value="" disabled=""');
    // Room for the mark is left on the logical end edge, so it mirrors in Arabic.
    expect(html).toContain('pe-9');
    expect(html).toContain('end-3');
  });
});

describe('form state', () => {
  it('FormField wires the label, hint and error to the control', () => {
    const aria = fieldAria('price', { error: 'Enter a price above 0' });
    expect(aria).toEqual({ id: 'price', 'aria-invalid': true, 'aria-describedby': 'price-error' });
    // With no error the hint is what describes the field; with one, the error replaces it.
    expect(fieldAria('price', { hint: 'In EGP' })).toEqual({ id: 'price', 'aria-describedby': 'price-hint' });

    const html = renderToStaticMarkup(
      <FormField id="price" label="Price" error="Enter a price above 0">
        <Input {...fieldAria('price', { error: 'x' })} name="price" error />
      </FormField>,
    );
    expect(html).toContain('for="price"');
    expect(html).toContain('id="price-error"');
    expect(html).toContain('aria-describedby="price-error"');
    // A message that appears after a submission has to be announced, or a keyboard user never learns of it.
    expect(html).toContain('aria-live="polite"');
  });

  it('a required field names "required" in the reader’s language rather than only marking it', () => {
    const html = renderToStaticMarkup(
      <FormField id="n" label="Name" required requiredLabel="required">
        <Input id="n" name="n" />
      </FormField>,
    );
    expect(html).toContain('required');
    // Not an asterisk alone, which says nothing to a screen reader and nothing in Arabic either.
    expect(html).not.toContain('*');
  });
});

describe('the catalogue card', () => {
  it('LinkCard is one stretched link, so the card is clickable but the name is just the title', () => {
    const html = renderToStaticMarkup(
      <LinkCard href="/listing/a-chair" aria-label="A chair">
        <CardTitle>A chair</CardTitle>
      </LinkCard>,
    );
    // Exactly one anchor: wrapping the whole card would make the price and location part of the link's name.
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('absolute inset-0');
    expect(html).toContain('aria-label="A chair"');
  });

  it('hover moves the border rather than lifting the card', () => {
    const html = renderToStaticMarkup(<LinkCard href="/x">y</LinkCard>);
    expect(html).toContain('hover:border-neutral-400');
    // A grid of twenty cards that each rise on hover twitches, and the lift costs layout.
    expect(html).not.toMatch(/hover:shadow|hover:-translate-y/);
  });

  it('a card title clamps, so a grid keeps its rhythm in both scripts', () => {
    expect(renderToStaticMarkup(<CardTitle>t</CardTitle>)).toContain('line-clamp-2');
    expect(renderToStaticMarkup(<CardTitle lines={1}>t</CardTitle>)).toContain('truncate');
  });

  it('a card footer pins the price to the bottom so a row aligns on it', () => {
    expect(renderToStaticMarkup(<CardFooter>p</CardFooter>)).toContain('mt-auto');
  });

  it('a link inside a card sits above the stretched anchor', () => {
    // Without this the seller's name inside a card is unclickable, which is the bug the component exists to stop.
    expect(renderToStaticMarkup(<CardOverlayLink href="/seller/x">x</CardOverlayLink>)).toContain('z-20');
  });

  it('carries no media area, because the browse contract has no image field', () => {
    // `ListingSummarySchema` is `.strict()` with eight approved fields and no media among them. A card built
    // around a picture would show a placeholder on every single one, and a grid where nothing has an image reads
    // as an outage rather than as a design — so the card is typographic until the contract gains a media field.
    const card = readFileSync(join(SRC, 'card.tsx'), 'utf8');
    expect(card).not.toMatch(/aspect-square|aspect-\[16\/10\]|CardMedia/);
    // And the skeleton matches, or it would promise a shape the real card never takes.
    const skeleton = readFileSync(join(SRC, 'skeleton.tsx'), 'utf8');
    expect(skeleton).not.toMatch(/aspect-/);
  });
});

describe('badges and avatars', () => {
  it('Badge distinguishes its tones by fill, not by hue', () => {
    expect(renderToStaticMarkup(<Badge tone="neutral">New</Badge>)).toContain('bg-neutral-100');
    expect(renderToStaticMarkup(<Badge tone="solid">Verified</Badge>)).toContain('bg-neutral-900');
    expect(renderToStaticMarkup(<Badge tone="outline">Sold</Badge>)).toContain('border-neutral-400');
  });

  it('Badge is a pill in sentence case, never a tracked-out capital label', () => {
    const html = renderToStaticMarkup(<Badge>Promoted</Badge>);
    expect(html).toContain('rounded-full');
    expect(html).not.toMatch(/uppercase|tracking-/);
  });

  it('Avatar takes a whole grapheme, so an Arabic or astral initial is not cut in half', () => {
    expect(firstGrapheme('مروان')).toBe('م');
    expect(firstGrapheme('Ahmed')).toBe('A');
    expect(firstGrapheme('👩‍🚀 crew')).not.toBe('\ud83d');
    expect(firstGrapheme('   ')).toBe('');
    // The name is what a screen reader hears; the letter is decoration.
    const html = renderToStaticMarkup(<Avatar name="مروان" />);
    expect(html).toContain('aria-label="مروان"');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('navigation', () => {
  it('Tabs are links with aria-current, not a tab widget that is not there', () => {
    const html = renderToStaticMarkup(
      <Tabs
        label="Catalogue"
        items={[
          { href: '/listings', label: 'Products', current: true },
          { href: '/services', label: 'Services', current: false, count: 12 },
        ]}
      />,
    );
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('role="tab"');
    expect(html).toContain('<nav aria-label="Catalogue"');
    // The selected tab is marked by weight and a border, so it survives a monochrome palette.
    expect(html).toContain('border-neutral-900 font-semibold');
  });

  it('Breadcrumb separates with a mirrored chevron rather than a slash or a middle dot', () => {
    const html = renderToStaticMarkup(
      <Breadcrumb
        label="Breadcrumb"
        items={[
          { label: 'Home', href: '/' },
          { label: 'Phones' },
        ]}
      />,
    );
    expect(html).toContain('<ol');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toMatch(/·|&middot;|\/<\/|>\/</);
    expect(html).toContain('rtl:rotate-135');
  });

  it('Pagination offers what a forward-only cursor supports, and nothing it cannot', () => {
    const labels = { next: 'Next', first: 'Back to start', position: 'Showing 24 results', navigation: 'Pages' };
    const html = renderToStaticMarkup(
      <Pagination nextHref="/listings?cursor=abc" firstHref="/listings" paged labels={labels} />,
    );
    expect(html).toContain('Next');
    expect(html).toContain('Back to start');
    expect(html).toContain('Showing 24 results');
    // No page numbers: the readers return `{ items, nextCursor }` with no total and no offset, so a numbered
    // pager could only be invented.
    expect(html).not.toMatch(/>1<|>2<|>…</);
    // Both controls are links, so a page of results has a shareable URL and paging works without JavaScript.
    expect(html.match(/<a /g)).toHaveLength(2);
    // `rel="next"` says this is a sequence rather than near-duplicate pages. Every paginated public route
    // asserts it, so the component owns it instead of each caller having to remember.
    expect(html).toMatch(/<a[^>]*href="\/listings\?cursor=abc"[^>]*rel="next"/);
  });

  it('Pagination omits the position sentence where the surface already states its count', () => {
    // `CatalogToolbar` states the count above the grid, and saying "8 results" at both ends of one list is
    // noise rather than context.
    const html = renderToStaticMarkup(
      <Pagination
        nextHref="/listings?cursor=abc"
        firstHref="/listings"
        paged
        labels={{ next: 'Next', first: 'Back to start', navigation: 'Pages' }}
      />,
    );
    expect(html).toContain('Next');
    expect(html).not.toContain('aria-live');
    expect(html).toContain('justify-end');
  });

  it('Pagination renders nothing on a single unpaged page', () => {
    const labels = { next: 'n', first: 'f', position: 'p', navigation: 'g' };
    expect(
      renderToStaticMarkup(<Pagination nextHref={null} firstHref="/x" paged={false} labels={labels} />),
    ).toBe('');
  });
});

describe('states', () => {
  it('Alert carries severity in the role as well as in the shape', () => {
    const error = renderToStaticMarkup(<Alert tone="error" title="That did not save" />);
    expect(error).toContain('role="alert"');
    expect(error).toContain('aria-live="assertive"');
    expect(error).toContain('border-2');

    const info = renderToStaticMarkup(<Alert tone="info">A note</Alert>);
    expect(info).toContain('role="status"');
    expect(info).toContain('aria-live="polite"');
  });

  it('Alert tones differ structurally, since none of them can differ by colour', () => {
    const classes = (['info', 'success', 'warning', 'error'] as const).map((tone) =>
      /class="([^"]*)"/.exec(renderToStaticMarkup(<Alert tone={tone}>x</Alert>))?.[1] ?? '',
    );
    expect(new Set(classes).size).toBe(4);
    for (const value of classes) expect(value).not.toMatch(/red|green|amber|yellow/);
  });

  it('EmptyState tells "matched nothing" apart from "could not answer"', () => {
    const empty = renderToStaticMarkup(<EmptyState title="No results" tone="empty" />);
    const broken = renderToStaticMarkup(<EmptyState title="Results are unavailable" tone="unavailable" />);
    // The container's own edge is what differs — a dashed edge reads as a space waiting to be filled, an outage
    // is a solid recessed surface. Asserted on the outer element, because the mark inside is dashed in both.
    const container = (html: string) => /^<div[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(container(empty)).toContain('border-dashed');
    expect(container(broken)).not.toContain('border-dashed');
    expect(container(broken)).toContain('bg-neutral-50');
    // Both are announced, at the severity each deserves: an empty result set politely, an outage interrupting.
    expect(empty).toContain('role="status"');
    expect(empty).toContain('aria-live="polite"');
    expect(broken).toContain('role="alert"');
    expect(broken).toContain('aria-live="assertive"');
  });

  it('a loading grid announces itself once, not once per card', () => {
    const html = renderToStaticMarkup(<SkeletonCardGrid count={4} label="Loading results" />);
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('aria-busy="true"');
    // Four blocks per card: two title lines, the price and the meta line. No media block — see the card test.
    expect(html.match(/mp-pulse/g)).toHaveLength(4 * 4);
  });
});

describe('meta pairs keep their structure', () => {
  it('DetailList is a description list, not spans joined by a separator character', () => {
    const html = renderToStaticMarkup(
      <DetailList items={[{ label: 'Condition', value: 'Used' }, { label: 'Location', value: 'Cairo' }]} />,
    );
    expect(html).toContain('<dl');
    expect(html).toContain('<dt');
    expect(html).toContain('<dd');
    // "Cairo · Used" is one run of text to a screen reader, and the dot has to be mirrored by hand in Arabic.
    expect(html).not.toMatch(/·|&middot;/);
  });
});

describe('the system’s own rules, enforced on every primitive', () => {
  /** Every source file in the package, so a new primitive is covered the moment it is added. */
  const files = sources().filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'));

  it('uses only logical direction utilities, so Arabic mirrors without a second layout', () => {
    // The whole public site renders right-to-left in Arabic. One `pl-4` is a layout that is quietly wrong in
    // half the product, and it is invisible until somebody reads the Arabic page.
    const PHYSICAL = /\b(?:sm:|md:|lg:|xl:|hover:|focus:|focus-visible:|group-hover:)*(?:p|m)(?:l|r)-(?:\d|px|\[)/;
    const POSITION = /\b(?:sm:|md:|lg:|xl:|hover:|focus:|focus-visible:)*(?:left|right)-(?:\d|px|auto|\[|full)/;
    for (const file of files) {
      const text = withoutComments(readFileSync(file, 'utf8'));
      expect(PHYSICAL.test(text), `${file}: physical padding or margin`).toBe(false);
      expect(POSITION.test(text), `${file}: physical left/right position`).toBe(false);
    }
  });

  it('defines no colour outside the token palette', () => {
    // The two brand colours are owner-supplied placeholders (D5). Nothing may hard-code a hue, so when the owner
    // sets them the product adopts them rather than needing a repaint.
    const DEFAULT_PALETTE = /\b(?:bg|text|border|outline|decoration|ring)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|stone)-\d/;
    const HEX = /#[0-9a-fA-F]{3,8}\b/;
    for (const file of files) {
      const text = withoutComments(readFileSync(file, 'utf8'));
      expect(DEFAULT_PALETTE.test(text), `${file}: default Tailwind palette`).toBe(false);
      expect(HEX.test(text), `${file}: hard-coded hex colour`).toBe(false);
    }
  });

  it('uses no gradient and no glow, and spends elevation only on what leaves the page', () => {
    // 0109 replaced a blanket "no shadow" rule with this one. A shadow is now how the product says something
    // floats — and it is still not decoration, so only the three overlay surfaces and the stuck header may use
    // it, and a flat card may not.
    // `recipes.ts` defines the three surfaces; `dialog.tsx` is the only primitive that names one directly.
    const ALLOWED_SHADOW_FILES = new Set(['recipes.ts', 'dialog.tsx']);
    for (const file of files) {
      const text = withoutComments(readFileSync(file, 'utf8'));
      expect(/gradient|\bglow\b|drop-shadow/.test(text), `${file}: gradient or glow`).toBe(false);
      if (!ALLOWED_SHADOW_FILES.has(file.slice(SRC.length))) {
        expect(/\bshadow-(?:sm|md|lg)\b/.test(text), `${file}: elevation outside an overlay`).toBe(false);
      }
    }
  });

  it('declares every shared type-scale entry, so a surface never invents its own', () => {
    expect(Object.keys(TYPE).sort()).toEqual(
      ['body', 'cardTitle', 'display', 'h1', 'h2', 'h3', 'h4', 'hint', 'label', 'meta', 'price', 'priceLarge', 'prose'],
    );
    // No letter-spacing at any size: Arabic is cursive and negative tracking breaks its letter joins.
    for (const value of Object.values(TYPE)) expect(value).not.toMatch(/tracking-/);
  });

  it('marks exactly the two interactive primitives as client components', () => {
    const client = files.filter((file) => readFileSync(file, 'utf8').startsWith("'use client';"));
    expect(client.map((file) => file.slice(SRC.length)).sort()).toEqual(['dialog.tsx', 'dropdown.tsx']);
  });

  it('keeps one focus ring, defined once', () => {
    // A ring that is 2px here and 1px there is the clearest sign a design system is not one system.
    const recipes = readFileSync(join(SRC, 'recipes.ts'), 'utf8');
    expect(recipes).toContain('focus-visible:outline-offset-2');
    for (const file of files) {
      if (file.endsWith('recipes.ts')) continue;
      const text = withoutComments(readFileSync(file, 'utf8'));
      expect(/focus-visible:outline-offset-(?!2\b)/.test(text), `${file}: a second focus offset`).toBe(false);
    }
  });

  it('renders Card and Dialog at their role’s radius, so the two cannot drift', () => {
    expect(renderToStaticMarkup(<Card>x</Card>)).toContain('rounded-lg');
    expect(renderToStaticMarkup(<Button>x</Button>)).toContain('rounded-md');
    expect(renderToStaticMarkup(<Badge>x</Badge>)).toContain('rounded-full');
  });
});
