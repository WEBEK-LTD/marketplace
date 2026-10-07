/**
 * The headers the proxy sets for the pages it renders (0094).
 *
 * Its own module, with no imports, because both the proxy — which runs in the edge-shaped runtime — and the root
 * layout read it, and neither should have to import the other's file to agree on one string.
 */

/**
 * Which chrome a surface carries.
 *
 * `navigation` means the composed header, footer and mobile drawer belong here; anything else, the header's absence
 * included, means the application's own plain chrome. Owner decision 2 is "public surfaces only", so the absent case
 * is the plain one deliberately: a page that somehow bypassed the proxy loses its editorial links rather than
 * putting them across somebody's account pages.
 *
 * The proxy deletes any inbound copy before setting its own, exactly as it does for the catalogue outcome: this
 * header is ours, and a value a client sent is not.
 */
export const SITE_CHROME_HEADER = 'x-site-chrome';

export const SITE_CHROME_NAVIGATION = 'navigation';
export const SITE_CHROME_PLAIN = 'plain';

/**
 * Which surface of the single application is answering (0108).
 *
 * One Next.js app now serves the public marketplace at `/` and the staff console at `/admin`. They share a runtime
 * and nothing else: separate document shells, separate message catalogues, separate locale models, separate
 * component trees. This header is how the three places that must know which surface they are in — the root layout,
 * the next-intl request config and the error boundary — learn it without inspecting a pathname they cannot see.
 *
 * It is derived from the path by {@link isAdminSurfacePath} in `@repo/config`, in the proxy, which is the one place
 * that sees the request before anything renders.
 *
 * **The proxy deletes any inbound copy before setting its own.** That is not a formality. Without it a client could
 * send `x-mp-surface: admin` to a public path and be served the console's document shell; it would carry no console
 * data and grant nothing, because authorization is server-side in the API and never derived from this header, but a
 * request header is not a fact about the request and is never treated as one.
 */
export const SURFACE_HEADER = 'x-mp-surface';

/** The staff console at `/admin`. */
export const SURFACE_ADMIN = 'admin';

/** The public marketplace at `/`. Also the value assumed when the header is absent. */
export const SURFACE_PUBLIC = 'public';
