import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Heading, PageContainer, SkipLink } from '../src/index.js';

describe('shared UI primitives', () => {
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
    expect(html).not.toMatch(/\bleft-|\bright-/);
  });

  it('Heading renders the requested level', () => {
    expect(renderToStaticMarkup(<Heading level={1}>Title</Heading>)).toBe(
      '<h1 class="text-3xl font-semibold text-neutral-900">Title</h1>',
    );
    expect(renderToStaticMarkup(<Heading level={3}>Sub</Heading>)).toMatch(/^<h3 /);
  });

  it('uses only token-based colours (no default palette, gradients or glows)', () => {
    const html = [
      renderToStaticMarkup(<PageContainer>a</PageContainer>),
      renderToStaticMarkup(<SkipLink targetId="c">b</SkipLink>),
      renderToStaticMarkup(<Heading level={2}>c</Heading>),
    ].join('');
    expect(html).not.toMatch(/gradient|shadow|glow|blue-|purple-|indigo-|violet-/);
  });
});
