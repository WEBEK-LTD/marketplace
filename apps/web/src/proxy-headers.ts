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
