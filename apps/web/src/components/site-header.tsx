import type { Locale } from '@repo/shared-types';
import { PageContainer, cx, FOCUS_RING } from '@repo/ui';
import type { ReactNode } from 'react';
import { SiteMenu } from './site-menu';

export interface SiteHeaderProps {
  readonly locale: Locale;
  readonly siteName: string;
  readonly languageLink: string;
  readonly languageLinkLabel: string;
  /**
   * The composed navigation, where this surface carries any (0094).
   *
   * Absent on the account and authentication surfaces (owner decision 2), and absent when no menu has been composed
   * or the menus could not be read — in which case this is exactly the header it has always been (owner decision 7).
   */
  readonly navigation?: ReactNode;
  /** The same menu again, for the width where a row of entries does not fit. */
  readonly mobileNavigation?: ReactNode;
  /** Copy for the drawer and the catalogue doors. The layout owns the translations. */
  readonly labels: {
    readonly menu: string;
    readonly closeMenu: string;
    readonly listings: string;
    readonly services: string;
    readonly categories: string;
  };
  /**
   * Whether this is a public surface (0094, owner decision 2).
   *
   * The account and authentication surfaces keep the plain chrome: the brand, and the locale switch that owner
   * decision 8 makes part of the application. Everything else in this header — the composed navigation, the
   * catalogue doors, the drawer that holds them — is public-surface only, and the layout decides which this is
   * from the same header the composed navigation already keys off.
   */
  readonly publicSurface: boolean;
}

/**
 * The site header.
 *
 * **Sticky, and the one surface in the product that carries elevation permanently.** A marketplace is browsed by
 * scrolling a long grid, and the search field and the language switch are wanted at the bottom of it as much as
 * at the top. It genuinely floats above the content, so `shadow-sm` is a statement of fact rather than
 * decoration — which is the rule the elevation scale exists to keep.
 *
 * **One row at every width.** The entries move into a drawer on a narrow viewport rather than stacking under the
 * brand, which is what the previous header did and what pushed every phone's content down by the height of the
 * menu — the first thing on a small screen that reads as an unfinished site.
 *
 * **The locale switch is part of the application, not of the navigation** (owner decision 8). It is an affordance
 * every page needs regardless of what anybody composed, so it stays here as code and is not an entry an operator
 * could delete. It carries `hrefLang` and `lang`, so a screen reader announces it in the language it offers
 * rather than mispronouncing "العربية" with an English voice.
 *
 * **The three catalogue doors appear in the drawer, on public surfaces only.** Products, services and categories
 * are routes that exist in code whatever an administrator arranges, so a visitor on a phone can always reach the
 * catalogue even if no menu was composed — the same reasoning owner decision 8 applies to the locale switch. They
 * are deliberately not repeated in the desktop header, where the composed navigation is the mechanism the product
 * chose for exactly that job; duplicating it there would put two competing menus in one row. And they do not
 * appear at all on the account and authentication surfaces, which owner decision 2 keeps on the plain chrome.
 *
 * **There is deliberately no search field here.** 0109 built one and then took it out: a persistent header search
 * is standard for a marketplace, but nothing in the specification authorises it and two approved decisions
 * conflict with it — the marketplace hub is documented as having "no search box, no filters, no sorting", and the
 * read-only seller surfaces are asserted to render no form at all, which a search form is. Search therefore lives
 * where it is already approved: the home page's opening band, and `/search` itself. Adding it to the header is one
 * owner decision away and one line of code; inventing it was not this increment's to do.
 */
export function SiteHeader({
  locale,
  siteName,
  languageLink,
  languageLinkLabel,
  navigation,
  mobileNavigation,
  labels,
  publicSurface,
}: SiteHeaderProps) {
  const otherLocale: Locale = locale === 'ar' ? 'en' : 'ar';
  const prefix = locale === 'ar' ? '/ar' : '';

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-200 bg-neutral-0 shadow-sm">
      <PageContainer>
        <div className="flex h-16 items-center justify-between gap-3 sm:gap-6">
          <a href={prefix === '' ? '/' : prefix} className={cx('shrink-0 rounded-sm text-lg font-semibold text-neutral-900', FOCUS_RING)}>
            {siteName}
          </a>

          <div className="flex items-center gap-2">
            {navigation === undefined ? null : <div className="hidden lg:block">{navigation}</div>}

            <a
              href={otherLocale === 'ar' ? '/ar' : '/'}
              hrefLang={otherLocale}
              lang={otherLocale}
              aria-label={languageLinkLabel}
              className={cx(
                'rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-900',
                'transition-colors duration-150 hover:border-neutral-400 hover:bg-neutral-50',
                FOCUS_RING,
              )}
            >
              {languageLink}
            </a>

            {publicSurface ? (
              <div className="lg:hidden">
                <SiteMenu menuLabel={labels.menu} closeLabel={labels.closeMenu} title={siteName}>
                  <div className="space-y-6">
                    <CatalogueDoors prefix={prefix} labels={labels} />
                    {mobileNavigation ?? navigation}
                  </div>
                </SiteMenu>
              </div>
            ) : null}
          </div>
        </div>
      </PageContainer>
    </header>
  );
}

/** The three routes that exist whatever an administrator composed. */
function CatalogueDoors({
  prefix,
  labels,
}: {
  readonly prefix: string;
  readonly labels: { readonly listings: string; readonly services: string; readonly categories: string };
}) {
  const entries = [
    { href: `${prefix}/listings`, label: labels.listings },
    { href: `${prefix}/services`, label: labels.services },
    { href: `${prefix}/categories`, label: labels.categories },
  ];
  return (
    <ul className="flex list-none flex-col border-t border-neutral-200">
      {entries.map((entry) => (
        <li key={entry.href} className="border-b border-neutral-200">
          <a
            href={entry.href}
            className={cx(
              'block py-3 text-base font-medium text-neutral-900 transition-colors duration-150 hover:text-neutral-600',
              FOCUS_RING,
            )}
          >
            {entry.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
