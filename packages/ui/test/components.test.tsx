import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Alert,
  Avatar,
  Badge,
  Band,
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
 * Every class token in a rendered fragment.
 *
 * Scanning the raw HTML for a word is not good enough: the product's shared transition names `border-color`
 * among the properties it animates, so a text search for `border` matches a component that draws none. Splitting
 * the `class` attributes into tokens asks the question that was actually meant — is `border` one of the classes.
 */
function classTokens(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) => (match[1] ?? '').split(/\s+/)).filter(Boolean);
}

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
    expect(html).toBe('<main id="content" class="mx-auto w-full px-5 sm:px-8 lg:px-12 max-w-[80rem]">x</main>');
    expect(renderToStaticMarkup(<PageContainer>y</PageContainer>)).toMatch(/^<div /);
    // The reading measure is a different thing from a small page: prose wants 65–75 characters a line whatever
    // the viewport is, so an auth form or a policy page is centred rather than stretched across 80rem.
    expect(renderToStaticMarkup(<PageContainer width="narrow">y</PageContainer>)).toContain('max-w-2xl');
  });

  it('SkipLink targets the content id and uses logical positioning', () => {
    const html = renderToStaticMarkup(<SkipLink targetId="content">Skip</SkipLink>);
    expect(html).toContain('href="#content"');
    expect(html).toContain('focus:start-4');
  });

  it('Heading renders the requested level, and display size keeps the level', () => {
    expect(renderToStaticMarkup(<Heading level={1}>Title</Heading>)).toMatch(/^<h1 class="[^"]*text-3xl/);
    expect(renderToStaticMarkup(<Heading level={4}>Sub</Heading>)).toMatch(/^<h4 /);
    // The document outline must not have to follow the type scale: an h1 may be display-sized, and a display
    // heading is still an h1.
    const display = renderToStaticMarkup(<Heading level={1} display>Big</Heading>);
    expect(display).toMatch(/^<h1 /);
    expect(display).toContain('lg:text-7xl');
    // The tracking hook, not a tracking utility: `globals.css` attaches Latin tracking to `.mp-display` under
    // `[lang="en"]` only, so an Arabic heading cannot receive it and have its letter joins broken.
    expect(display).toContain('mp-display');
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
    expect(renderToStaticMarkup(<Section space="lg">a</Section>)).toContain('py-14 sm:py-20');
    expect(renderToStaticMarkup(<Section space="sm">a</Section>)).toContain('py-8');
  });

  it('Band is full-bleed, and carries one of the three page surfaces', () => {
    // The band is the unit a public page is composed from (0110). `.mp-band` is what reaches the viewport
    // edges; the tone is what makes a stack of them a composition rather than a column of divs.
    for (const [tone, surface] of [
      ['canvas', 'bg-surface-canvas'],
      ['sunken', 'bg-surface-sunken'],
      ['ink', 'bg-surface-ink'],
    ] as const) {
      const html = renderToStaticMarkup(<Band tone={tone}>x</Band>);
      expect(html, tone).toContain('mp-band');
      expect(html, tone).toContain(surface);
    }
    // An ink band inverts the text role with it, so no caller has to remember to.
    expect(renderToStaticMarkup(<Band tone="ink">x</Band>)).toContain('text-on-ink');
  });
});

describe('controls', () => {
  it('Button renders every variant and keeps one focus ring', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const html = renderToStaticMarkup(<Button variant={variant}>Go</Button>);
      // The ring takes the brand accent, so the day two real colours arrive the keyboard ring is branded
      // everywhere at once rather than in whichever components someone remembered.
      expect(html, variant).toContain('focus-visible:outline-brand-primary');
      expect(html, variant).toContain('rounded-lg');
    }
    // On an ink band the ring inverts, because the accent has no guaranteed contrast against near-black.
    for (const variant of ['onInk', 'onInkGhost'] as const) {
      expect(renderToStaticMarkup(<Button variant={variant}>Go</Button>), variant).toContain(
        'focus-visible:outline-on-ink',
      );
    }
  });

  it('a destructive button is marked by weight, because the palette has no red', () => {
    const html = renderToStaticMarkup(<Button variant="danger">Delete listing</Button>);
    // Two steps of emphasis where every other control has one, and a full inversion at the moment of the click.
    expect(html).toContain('ring-2');
    expect(html).toContain('hover:bg-surface-ink');
    expect(html).toContain('font-semibold');
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
    expect(plain).toContain('ring-1 ring-edge');
    expect(errored).toContain('ring-2 ring-edge-strong');
    // The 2px replaces the 1px rather than adding to it, so a refused form does not reflow. A ring rather than
    // a border is what guarantees that: a ring is painted outside the box and takes no part in layout, so a
    // field and a button declared at the same height actually are the same height.
    expect(errored).not.toContain('ring-1 ring-edge');
    expect(classTokens(plain)).not.toContain('border');
    expect(renderToStaticMarkup(<Textarea id="d" name="d" />)).toContain('rounded-lg');
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

  it('hover lifts the card, which is the affordance that says the whole tile is the target', () => {
    const html = renderToStaticMarkup(<LinkCard href="/x">y</LinkCard>);
    expect(html).toContain('hover:-translate-y-0.5');
    expect(html).toContain('hover:shadow-md');
    // The card is separated from the band behind it by value and the faintest lift, never by a rectangle drawn
    // on all four sides — twenty of those down a grid is a table, which is what 0109's catalogue looked like.
    expect(html).toContain('bg-surface-raised');
    expect(classTokens(html)).not.toContain('border');
    // The focus ring reaches the whole card, so a keyboard shows the same target the pointer gets.
    expect(html).toContain('focus-within:outline-brand-primary');
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
    expect(renderToStaticMarkup(<Badge tone="neutral">New</Badge>)).toContain('bg-surface-muted');
    expect(renderToStaticMarkup(<Badge tone="solid">Verified</Badge>)).toContain('bg-surface-ink');
    expect(renderToStaticMarkup(<Badge tone="outline">Sold</Badge>)).toContain('border-edge');
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
    expect(html).toContain('border-edge-strong font-semibold');
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
    // The RTL rotation is `+45`, not the mirror of the LTR one: `border-e` has already moved to the other
    // side in RTL, so the corner the chevron is drawn from starts 90° away. `breadcrumb.tsx` has the
    // arithmetic. Both renderings were wrong before a screenshot settled it, so both halves are pinned here.
    expect(html).toContain('-rotate-45');
    expect(html).toContain('rtl:rotate-45');
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
    expect(container(broken)).toContain('bg-surface-muted');
    // An empty result set sits on the brand's own pale wash — it is an ordinary state of a working
    // catalogue. An outage sits on the neutral muted surface, because nothing about it belongs to the brand.
    expect(container(empty)).toContain('bg-surface-sunken');
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

  it('uses no gradient and no glow, and names elevation only in the file that defines it', () => {
    // 0110 widened what a shadow may say — a card now lifts off a recessed band, which 0109 forbade — and
    // keeps it bounded to the five declared steps in three named places. `recipes.ts` declares the surfaces;
    // `button.tsx` is the one control that is itself elevated, because a filled button on a flat page needs to
    // read as pressable; `dialog.tsx` names one directly because the `<dialog>` element's own panel cannot
    // take a surface constant. Anywhere else, a shadow is decoration.
    const ALLOWED_SHADOW_FILES = new Set(['recipes.ts', 'button.tsx', 'dialog.tsx']);
    for (const file of files) {
      const text = withoutComments(readFileSync(file, 'utf8'));
      expect(/gradient|\bglow\b|drop-shadow/.test(text), `${file}: gradient or glow`).toBe(false);
      if (!ALLOWED_SHADOW_FILES.has(file.slice(SRC.length))) {
        expect(/\bshadow-(?:xs|sm|md|lg)\b/.test(text), `${file}: elevation outside recipes.ts`).toBe(false);
      }
    }
  });

  it('declares every shared type-scale entry, so a surface never invents its own', () => {
    expect(Object.keys(TYPE).sort()).toEqual([
      'body',
      'cardTitle',
      'cardTitleLarge',
      'display',
      'displaySm',
      'eyebrow',
      'h1',
      'h2',
      'h3',
      'h4',
      'hint',
      'label',
      'lead',
      'meta',
      'metaSmall',
      'prose',
    ]);
    // The scale spans 0.75rem to 4.5rem. A page whose largest element is six times its smallest reads as
    // composed; 0109's ran from 0.875rem to 3rem with almost everything between 1rem and 1.5rem, which is why
    // every page looked like the same page.
    expect(TYPE.metaSmall).toContain('text-xs');
    expect(TYPE.display).toContain('lg:text-7xl');
    // **No tracking utility reaches a component.** The tokens exist now, but `globals.css` attaches them to
    // `.mp-display` under `[lang="en"]` only — so Arabic, which is cursive and whose joins negative tracking
    // breaks, can never receive them. A `tracking-` class here would route around that scoping.
    for (const value of Object.values(TYPE)) expect(value).not.toMatch(/tracking-/);
    for (const file of files) {
      expect(/\btracking-/.test(withoutComments(readFileSync(file, 'utf8'))), `${file}: tracking utility`).toBe(
        false,
      );
    }
  });

  it('speaks to the semantic ladder, never to the raw neutral ramp', () => {
    // The rule that replaces 0109's "no default palette" check, and a stronger one. A component asking for
    // `neutral-200` has made a value judgement that belongs in the token file; a component asking for
    // `border-hairline` has named a role. Only the ladder can be re-valued from one place, and only the ladder
    // makes it visible whether the design has enough distinct steps to hold a hierarchy.
    for (const file of files) {
      const text = withoutComments(readFileSync(file, 'utf8'));
      expect(/\b(?:bg|text|border|ring|fill|decoration|accent|outline)-neutral-\d/.test(text), `${file}: raw ramp`).toBe(
        false,
      );
      // And no hard-coded colour of any kind, which is D5: brand is an admin setting, never in a component.
      expect(/#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/.test(text), `${file}: hard-coded colour`).toBe(false);
    }
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

  it('renders each thing at its role’s radius, so the scale cannot drift', () => {
    // A 14px corner on a 320px card and a 6px corner on a 44px control are the same gesture at two scales.
    // Using one value for both is what makes an interface look like a template, which is why the roles are
    // pinned here rather than left to whoever writes the next component.
    expect(renderToStaticMarkup(<Card>x</Card>)).toContain('rounded-xl');
    expect(renderToStaticMarkup(<LinkCard href="/x">y</LinkCard>)).toContain('rounded-xl');
    expect(renderToStaticMarkup(<Button>x</Button>)).toContain('rounded-lg');
    expect(renderToStaticMarkup(<Input id="a" name="a" />)).toContain('rounded-lg');
    expect(renderToStaticMarkup(<Badge>x</Badge>)).toContain('rounded-full');
  });
});
