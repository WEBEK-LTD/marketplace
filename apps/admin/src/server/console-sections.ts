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
 * catalogue are different jobs. `seo` is a partial departure: the redirect map and the metadata overrides each have
 * an entry, while that module's site-wide settings cluster still has a table, a seeded key and no increment, so it
 * still has none.
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
  // Phase 8, increment 0092. The mechanism above once more: a new route with a key 0033 already seeds. It is a
  // separate entry from `cms` because it is a separate key — `cms.blog.read` and `cms.page.read` are different
  // permissions, and authoring the blog is a different job from maintaining the legal pages. The FAQ, homepage,
  // banner and navigation clusters keep their seeded keys and no section, because they still have no increment.
  { id: 'blog', href: '/blog', permission: 'cms.blog.read' },
  // Phase 8, increment 0093. Another key 0033 already seeds, and a separate entry because composing the homepage
  // and maintaining the legal pages are different jobs behind different permissions. The banner, FAQ and
  // navigation clusters keep their seeded keys and no section, because they still have no increment — and banners
  // cannot have one until a media origin exists.
  { id: 'homepage', href: '/cms/homepage', permission: 'cms.homepage.read' },
  // Phase 8, increment 0094. Another key 0033 already seeds, and a separate entry for the same reason: arranging
  // the header, footer and mobile drawer is a different job from composing the front page or maintaining the legal
  // pages, behind a different permission. The banner and FAQ clusters keep their seeded keys and no section — the
  // FAQ because it still has no increment, and a banner because it cannot have one until a media origin exists.
  { id: 'navigation', href: '/cms/navigation', permission: 'cms.navigation.read' },
  // Phase 8, increment 0095. The last key in the `cms` module that 0033 seeds and nothing used: writing the help
  // centre is a different job from the legal pages, the front page or the menus, behind its own permission. The
  // banner cluster keeps its seeded keys and no section, because a banner cannot have one until a media origin
  // exists — which leaves `cms.media.manage` as the only `cms` key with no section at all.
  { id: 'faqs', href: '/cms/faqs', permission: 'cms.faq.read' },
  // Phase 8, increment 0098. The last `cms` key 0033 seeds and nothing used, and the second place in this list gated
  // on a **manage** key: there is no `cms.media.read` in the seed and none was invented. Until this increment the
  // `cms-media` bucket did not exist, so the table could hold nothing — which is why the four columns that point at
  // it across 0085, 0091, 0092 and 0096 have all been handing out paths nothing could resolve. The banner cluster
  // keeps its seeded keys and no section: 0098 makes a banner's media possible and builds no banner.
  { id: 'cmsMedia', href: '/cms/media', permission: 'cms.media.manage' },
  // Phase 8-E. The mechanism above working as designed once more: a new route with a key 0033 already seeds. `seo`
  // leaves the unbuilt list below with this one entry and nothing else — the metadata and settings clusters still
  // have tables, seeded keys and no increment, so they still have no section. It is gated on the read key, and
  // `seo.redirect.manage` is what the controls inside it need.
  { id: 'seoRedirects', href: '/seo/redirects', permission: 'seo.redirect.read' },
  // Phase 8-F. The second entry in the `seo` module, gated on another key 0033 already carries: maintaining the
  // redirect map and maintaining the metadata overrides are different jobs behind different keys, so they are
  // different sections.
  { id: 'seoMetadata', href: '/seo/metadata', permission: 'seo.metadata.read' },
  // Phase 8, increment 0096. The third and last entry in the `seo` module, and the one place in this list gated on a
  // **manage** key: 0033 seeds `seo.settings.manage` and no `seo.settings.read`, so there is no read key to gate it
  // on and none is invented. The mechanism is the same as everywhere else — a new route with a key 0033 already
  // seeds — and the consequence is particular to this section: whoever can open it may change it. The `seo` module
  // now has a section for every key it carries.
  { id: 'seoSettings', href: '/seo/settings', permission: 'seo.settings.manage' },
  { id: 'platform', href: '/platform/jobs', permission: 'platform.job.read' },
  // Phase 8, increment 0102. The mechanism above working as designed once more, and the **first** section for the
  // `analytics` module: 0033 seeds `analytics.listing.read` and nothing has consumed it since. Until 0101 there
  // was nothing to read, and until 0102 there was no rollup to read it from. The key is held by Admin and Super
  // Admin alone, so this section refuses as many people as the platform one does.
  { id: 'listingAnalytics', href: '/analytics/listings', permission: 'analytics.listing.read' },
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
