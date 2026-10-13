/**
 * The brand chrome, removed, so an assertion about a *page* is about the page.
 *
 * Every document this application serves now carries the brand lockup in its header and footer and the
 * favicon links in its head. Both are two `<img>` elements with `.svg` sources and a handful of
 * `<link rel="icon">` tags — which is exactly the shape a dozen assertions were using as a proxy for
 * something else entirely:
 *
 *   * "the private bucket's images never reach this page" was written as `not.toContain('<img')`;
 *   * "the file picker offers no SVG" was written as `not.toContain('svg')`.
 *
 * Both were true, and both were true only while the chrome happened to contain no image. The claims are
 * unchanged and still worth holding; what changes is that they are now asked of the page's own markup
 * rather than of every byte the server sent. Loosening them instead — to `not.toContain('storage')`, say —
 * would have kept them passing while quietly narrowing what they rule out.
 *
 * This removes the chrome by its own addresses, so a page that rendered an `<img>` of its own, or a picker
 * that offered `image/svg+xml`, still fails exactly as before.
 */
export function withoutBrandChrome(html: string): string {
  return html
    .replace(/<link[^>]+rel="(?:icon|apple-touch-icon|shortcut icon|manifest)"[^>]*>/gi, '')
    // The framework emits a preload for each lockup image of its own accord, which is three more places
    // the word `svg` appears in a document that draws nothing.
    .replace(/<link[^>]+href="\/brand\/[^"]*"[^>]*>/gi, '')
    .replace(/<img[^>]+src="\/brand\/[^"]*"[^>]*>/gi, '');
}

/**
 * Every `accept` attribute on the page, which is what a question about a file picker is actually about.
 *
 * Asking the whole document whether it contains `image/svg+xml` was a fair proxy until the head gained a
 * `<link rel="icon" type="image/svg+xml">` — and that link is also written into the flight payload as
 * escaped JSON, where no amount of tag-stripping will reach it. The picker's own attribute is both exact
 * and immune to anything the framework adds around it.
 */
export function acceptAttributes(html: string): readonly string[] {
  return [...html.matchAll(/accept="([^"]*)"/g)].map((match) => match[1] ?? '');
}
