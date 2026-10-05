import Link from 'next/link';
import {
  isCmsPageSlug,
  publicBlogPostPath,
  publicCategoryPath,
  publicCmsPagePath,
  type PublicLocale,
} from '@repo/config';
import type { PublicNavigationLink, PublicNavigationMenu, PublicNavigationTarget } from '@repo/contracts';

/**
 * The site's own navigation, rendered (0094).
 *
 * **Nothing here decides what to show.** Which menus exist, which entries they still have and in what order are all
 * settled before this renders: the database drops an entry whose target is no longer public and the API drops a
 * menu left with nothing.
 *
 * **This file owns one decision, and it is the route map.** An entry names a page, a post or a category by *slug*,
 * and the address for each is built here with the same helpers every other link on this site uses. Owner decision 4
 * lives in the first of those: a published page whose slug is outside the closed set of addresses this application
 * serves has no address to link to, so the entry is dropped — here, because this is the only layer that knows.
 *
 * **Two levels, and the second one is a native disclosure in the header** (owner decision 5). `<details>` needs no
 * JavaScript, is keyboard-operable and is announced by a screen reader as what it is, which is three reasons not to
 * build a menu out of click handlers. The footer groups the second level under its heading instead, which is what a
 * footer column is.
 *
 * **`opens_in_new_tab` is honoured** (owner decision 6), with `rel="noopener noreferrer"`. Every path is relative,
 * so a new tab is always same-site; the `rel` is there because a target without it is a habit worth not having.
 *
 * Server components throughout: the chrome is content, and the HTML has to carry it for a crawler and for a visitor
 * with no JavaScript.
 */

const LINK_CLASS = 'text-sm text-neutral-700 underline-offset-2 hover:underline';

/**
 * Where one entry leads, or null when this application serves no address for it.
 *
 * A stored path is the operator's own and is used as written, with one adjustment: an Arabic visitor is kept in
 * Arabic. A path that already names the Arabic prefix is left alone, so an operator who meant one specific address
 * gets it.
 */
export function navigationHref(locale: PublicLocale, target: PublicNavigationTarget): string | null {
  switch (target.kind) {
    case 'page':
      // Owner decision 4: the closed set of served page addresses is this application's, and a page outside it has
      // no address to offer. Dropped rather than linked to a 404.
      return isCmsPageSlug(target.slug) ? publicCmsPagePath(locale, target.slug) : null;
    case 'blog_post':
      return publicBlogPostPath(locale, target.slug);
    case 'category':
      return publicCategoryPath(locale, target.slug);
    case 'path': {
      if (locale !== 'ar') return target.path;
      if (target.path === '/ar' || target.path.startsWith('/ar/')) return target.path;
      return target.path === '/' ? '/ar' : `/ar${target.path}`;
    }
  }
}

/** One entry with its address resolved, which is the only form the renderers below accept. */
interface ResolvedLink {
  readonly itemId: string;
  readonly label: string;
  readonly href: string;
  readonly opensInNewTab: boolean;
  readonly children: readonly ResolvedLink[];
}

function resolveLink(locale: PublicLocale, link: PublicNavigationLink): ResolvedLink | null {
  const href = navigationHref(locale, link.target);
  if (href === null) return null;
  return { itemId: link.itemId, label: link.label, href, opensInNewTab: link.opensInNewTab, children: [] };
}

/**
 * The menus with every address resolved, and anything unaddressable dropped.
 *
 * A heading that cannot be linked takes its children with it, for the reason the database applies to a heading whose
 * target is not public: an entry without its heading is not the arrangement that was made. A menu left with nothing
 * is dropped too, so no renderer below has an empty case.
 */
export function resolveMenus(
  locale: PublicLocale,
  menus: readonly PublicNavigationMenu[],
): readonly { readonly menuKey: string; readonly label: string; readonly items: readonly ResolvedLink[] }[] {
  return menus.flatMap((menu) => {
    const items = menu.items.flatMap((item) => {
      const resolved = resolveLink(locale, item);
      if (resolved === null) return [];
      const children = item.children.flatMap((child) => {
        const resolvedChild = resolveLink(locale, child);
        return resolvedChild === null ? [] : [resolvedChild];
      });
      return [{ ...resolved, children }];
    });
    return items.length === 0 ? [] : [{ menuKey: menu.menuKey, label: menu.label, items }];
  });
}

function Anchor({ link, className }: { readonly link: ResolvedLink; readonly className?: string }) {
  if (link.opensInNewTab) {
    return (
      <Link
        className={className ?? LINK_CLASS}
        href={link.href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {link.label}
      </Link>
    );
  }
  return (
    <Link className={className ?? LINK_CLASS} href={link.href}>
      {link.label}
    </Link>
  );
}

/**
 * The header menu: one row of entries, each with a native disclosure where it has a second level.
 *
 * Rendered inside the header's own `<nav>`, labelled with the menu's own words so a screen reader announces which
 * navigation it is.
 */
export function HeaderMenu({
  menu,
}: {
  readonly menu: { readonly label: string; readonly items: readonly ResolvedLink[] };
}) {
  return (
    <nav aria-label={menu.label}>
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {menu.items.map((item) => (
          <li key={item.itemId}>
            {item.children.length === 0 ? (
              <Anchor link={item} />
            ) : (
              /* Owner decision 5: a native disclosure, so the second level works with no JavaScript at all. */
              <details className="group relative">
                <summary className="cursor-pointer list-none text-sm text-neutral-700">{item.label}</summary>
                <ul className="mt-2 space-y-1 rounded-md border border-neutral-200 bg-white p-3 sm:absolute sm:z-10 sm:min-w-48">
                  {/* The heading is a link too, and it is repeated inside: a summary cannot be a link, so the
                      address an operator chose for it would otherwise be unreachable. */}
                  <li>
                    <Anchor link={item} />
                  </li>
                  {item.children.map((child) => (
                    <li key={child.itemId}>
                      <Anchor link={child} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The mobile drawer: the whole menu behind one disclosure, for the width where a row of entries does not fit. */
export function MobileMenu({
  menu,
}: {
  readonly menu: { readonly label: string; readonly items: readonly ResolvedLink[] };
}) {
  return (
    <nav aria-label={menu.label}>
      <details>
        <summary className="cursor-pointer list-none text-sm font-medium text-neutral-900">{menu.label}</summary>
        <ul className="mt-3 space-y-2">
          {menu.items.map((item) => (
            <li key={item.itemId}>
              <Anchor link={item} />
              {item.children.length === 0 ? null : (
                <ul className="mt-2 space-y-2 border-s border-neutral-200 ps-3">
                  {item.children.map((child) => (
                    <li key={child.itemId}>
                      <Anchor link={child} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </details>
    </nav>
  );
}

/**
 * The footer menu: the second level grouped under its heading, which is what a footer column is (owner decision 5).
 *
 * A heading with no children is a column of one, rather than a special case.
 */
export function FooterMenu({
  menu,
}: {
  readonly menu: { readonly label: string; readonly items: readonly ResolvedLink[] };
}) {
  return (
    <nav aria-label={menu.label}>
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {menu.items.map((item) => (
          <li key={item.itemId}>
            <Anchor className="text-sm font-medium text-neutral-900 underline-offset-2 hover:underline" link={item} />
            {item.children.length === 0 ? null : (
              <ul className="mt-2 space-y-1">
                {item.children.map((child) => (
                  <li key={child.itemId}>
                    <Anchor link={child} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
