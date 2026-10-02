import 'server-only';

/**
 * The console's sections, and the permission each one is gated on (Phase 7-F).
 *
 * **One list, used twice.** The navigation is built from it and every section page gates on the same
 * entry, so a link and the page it points at can never disagree about who may open it. A section added
 * here without a route, or a route added without an entry, is the kind of drift this module exists to
 * make impossible — the page reads its permission from here rather than repeating a string.
 *
 * **Every key is one 0033 already seeds.** Not one permission is invented, granted or assigned by 7-F:
 * these are read permissions that exist in `public.permissions` today, and the effective set a person
 * holds is decided in the database by 0003's own rule. The shell only asks whether a key it was given
 * is in the set it was given.
 *
 * **A read permission gates the section, deliberately.** `catalog.listing.read` opens the catalogue
 * section; `catalog.listing.moderate` is what a moderation *action* inside it would need, and that
 * belongs to the increment that builds the action. Gating a shell on a manage permission would hide the
 * section from people who are meant to read it.
 *
 * **Nothing here is a business screen.** Each route renders the section's own empty state and says which
 * increment brings its tools. There is no dashboard, no count, no KPI and no statistic anywhere in 7-F —
 * inventing one would be inventing the very numbers this increment is told not to invent.
 *
 * The modules with no entry — payments, payouts, finance, orders, marketing, settings and analytics — have
 * permissions in the database and no increment that built them, so they have no section here. A navigation
 * entry for a domain nobody has built would be a link to nothing. `cms` left that list when the static pages
 * section arrived: its entry gates on `cms.page.read`, and `cms.page.manage` is what the authoring controls
 * inside it need. The category tree arrived the same way, with its own `catalog.category.read` entry beside the
 * listing queue's `catalog.listing.read` one — two keys, because moderating a listing and restructuring the
 * catalogue are different jobs. `seo` is a partial departure: the redirect map has an entry, while the metadata
 * and settings clusters of that same module still have tables, seeded keys and no increment, so they still have
 * none.
 */

export interface ConsoleSection {
  /** Stable identifier, and the message key under `Sections` in both languages. */
  readonly id: string;
  /** The route this section owns, relative to the console root. */
  readonly href: string;
  /** The seeded permission key a person must hold for this section to exist for them. */
  readonly permission: string;
}

export const CONSOLE_SECTIONS: readonly ConsoleSection[] = Object.freeze([
  { id: 'sellers', href: '/sellers', permission: 'sellers.profile.read' },
  // Phase 7-G. The only change this list has had since 7-F, and it is the mechanism above working as
  // designed rather than an exception to it: a new route with a key 0033 already seeds. It is a separate
  // entry from `sellers` because it is gated on a different, narrower permission — `sellers.profile.read`
  // belongs to moderators too, and `sellers.verification.review` does not.
  {
    id: 'sellerVerification',
    href: '/sellers/verification',
    permission: 'sellers.verification.review',
  },
  // Phase 7-J. The same mechanism again: a new route with a key the database seeds — 0072's
  // `service_requests.request.read`. Gated on the read permission rather than on `manage`, because the
  // section is where a colleague reads the queue; closing a request needs `manage`, which the API and the
  // database check on that one action. The payment fields inside are gated a third time, on their own key.
  {
    id: 'serviceRequests',
    href: '/service-requests',
    permission: 'service_requests.request.read',
  },
  { id: 'catalog', href: '/catalog', permission: 'catalog.listing.read' },
  // The category tree, which is a separate key from the listing review queue it sits beside: a colleague who
  // moderates listings does not thereby get to restructure the catalogue.
  { id: 'categories', href: '/catalog/categories', permission: 'catalog.category.read' },
  // Phase 8-C. Two more entries beside the tree, and the exception to the read-permission rule above: neither
  // vocabulary has a read key — `catalog.attribute.read` and `catalog.tag.read` do not exist in
  // `public.permissions` and were not invented here — so each section is gated on the manage key its own table's
  // RLS policy names. They are separate entries because they are separate keys: maintaining the attribute
  // vocabulary and maintaining the tag vocabulary are different jobs, and neither is restructuring the tree.
  { id: 'attributes', href: '/catalog/attributes', permission: 'catalog.attribute.manage' },
  { id: 'tags', href: '/catalog/tags', permission: 'catalog.tag.manage' },
  { id: 'reviews', href: '/reviews', permission: 'reviews.review.read' },
  // Phase 7-N. The href moved from `/moderation` to the section's real home, which is the mechanism this
  // file describes working as designed: the section now has two screens, and the entry points at the one a
  // colleague starts from. `/moderation` itself still exists and redirects here, so an address that used to
  // work still does. The permission is unchanged — 7-F already seeded this entry with it.
  { id: 'moderation', href: '/moderation/reports', permission: 'moderation.report.read' },
  { id: 'support', href: '/support', permission: 'support.ticket.read' },
  { id: 'disputes', href: '/disputes', permission: 'disputes.dispute.read' },
  { id: 'recovery', href: '/security/recovery', permission: 'security.recovery.review' },
  { id: 'users', href: '/users', permission: 'users.profile.read' },
  { id: 'audit', href: '/audit', permission: 'audit.read' },
  { id: 'cms', href: '/cms/pages', permission: 'cms.page.read' },
  // Phase 8-E. The mechanism above working as designed once more: a new route with a key 0033 already seeds. `seo`
  // leaves the unbuilt list below with this one entry and nothing else — the metadata and settings clusters still
  // have tables, seeded keys and no increment, so they still have no section. It is gated on the read key, and
  // `seo.redirect.manage` is what the controls inside it need.
  { id: 'seoRedirects', href: '/seo/redirects', permission: 'seo.redirect.read' },
  { id: 'platform', href: '/platform/jobs', permission: 'platform.job.read' },
] as const);

/** The sections one permission set opens. Never a superset, and never role-based. */
export function sectionsFor(permissions: readonly string[]): readonly ConsoleSection[] {
  const held = new Set(permissions);
  return CONSOLE_SECTIONS.filter((section) => held.has(section.permission));
}

/** One section by its route, or null. Used by a page to find the permission it must gate on. */
export function sectionByHref(href: string): ConsoleSection | null {
  return CONSOLE_SECTIONS.find((section) => section.href === href) ?? null;
}
