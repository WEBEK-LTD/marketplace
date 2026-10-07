import { ADMIN_SURFACE_PREFIX } from '@repo/config';

/**
 * Where the console is mounted, and the only module that knows it (0108).
 *
 * The console used to be an application on its own origin, so every address inside it was simply root-relative:
 * `/catalog`, `/users`, `/api/faqs`. It now lives under `/admin` on the public origin, and the obvious way to carry
 * that — prefixing ninety-odd literals by hand — would mean ninety-odd places that each have to be right, and a
 * ninety-first that gets added later and is not.
 *
 * So the literals stay **console-relative**, exactly as they were, and the prefix lives here. A path written
 * anywhere in the console is the path as the console sees it; this is what turns it into the address the browser
 * uses. Moving the console again would be one edit in `@repo/config`, which is where the prefix itself is declared,
 * and nothing else.
 *
 * Two names rather than one, over one implementation: {@link adminPath} for a page the reader navigates to, and
 * {@link adminApiPath} for the console's own BFF. They do the same thing, and a reader can see from the call site
 * which boundary is being crossed.
 */
export { ADMIN_SURFACE_PREFIX };

/** The shape a console-relative path must have: root-relative, and not already prefixed. */
function assertConsoleRelative(path: string): void {
  if (!path.startsWith('/')) {
    throw new TypeError(`A console path must be root-relative, received ${JSON.stringify(path)}.`);
  }
  if (path === ADMIN_SURFACE_PREFIX || path.startsWith(`${ADMIN_SURFACE_PREFIX}/`)) {
    // Double-prefixing produces `/admin/admin/users`, which is a 404 that looks like a routing bug rather than the
    // call-site mistake it is. Refused loudly so it is found while it is being written.
    throw new TypeError(`A console path is already console-relative, received ${JSON.stringify(path)}.`);
  }
}

/**
 * The browser address of a console page, from the path the console uses for it.
 *
 * `adminPath('/catalog')` → `/admin/catalog`. A query string and a hash come through untouched, because they are
 * part of the path the caller composed and none of this module's business.
 */
export function adminPath(path: string): string {
  assertConsoleRelative(path);
  return `${ADMIN_SURFACE_PREFIX}${path}`;
}

/**
 * The browser address of one of the console's own BFF route handlers.
 *
 * `adminApiPath('/api/faqs')` → `/admin/api/faqs`. Identical to {@link adminPath} by construction — the handlers
 * live in the console's own route tree and move with it — and named apart so a call site reads as a call to the
 * console's server rather than a navigation.
 */
export function adminApiPath(path: string): string {
  return adminPath(path);
}
