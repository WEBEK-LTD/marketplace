import type { Locale } from '@repo/shared-types';
import { cx, firstGrapheme, FOCUS_RING, PageContainer } from '@repo/ui';
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
 * **Sticky and translucent.** A marketplace is browsed by scrolling a long grid, and the brand and the language
 * switch are wanted at the bottom of it as much as at the top. The backdrop blur is what makes that read
 * correctly: content scrolling under a solid bar looks like it disappeared, where content scrolling under a
 * translucent one looks like it went behind something.
 *
 * **It is 72px tall and the brand is set at 20–22px.** That sounds like trimming, and it is the difference
 * between a header that frames a product and the thin strip of 14px links this replaced, which read as browser
 * chrome. A marketplace header is the first thing a visitor sees and it has to carry some weight.
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
    <header className="sticky top-0 z-40 border-b border-hairline bg-surface-canvas/85 backdrop-blur-md">
      <PageContainer>
        <div className="flex h-[4.5rem] items-center justify-between gap-4 sm:gap-8">
          {/*
            The brand mark: a filled square carrying the site's first character, then the name. A wordmark
            alone at 22px is indistinguishable from a heading, and this product has no logo asset to use —
            a monogram built from the name it already has is the honest way to give the header an anchor,
            and it is the one place the brand colour appears as a solid fill above the fold.
          */}
          <a
            href={prefix === '' ? '/' : prefix}
            className={cx('group flex shrink-0 items-center gap-2.5 rounded-lg', FOCUS_RING)}
          >
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-lg bg-brand-700 text-base font-semibold text-on-ink transition-colors duration-200 group-hover:bg-brand-600"
            >
              {firstGrapheme(siteName)}
            </span>
            <span className="text-xl font-semibold text-ink-strong sm:text-[1.375rem]">{siteName}</span>
          </a>

          <div className="flex items-center gap-1 sm:gap-3">
            {navigation === undefined ? null : <div className="hidden lg:block">{navigation}</div>}

            {/*
              The locale switch is part of the application rather than of the navigation (owner decision 8), so
              a hairline separates it from the composed menu instead of it sitting in that row as a peer. That
              is the same distinction the drawer makes, drawn rather than stated.
            */}
            {navigation === undefined ? null : (
              <span aria-hidden="true" className="hidden h-6 w-px bg-hairline lg:block" />
            )}

            <a
              href={otherLocale === 'ar' ? '/ar' : '/'}
              hrefLang={otherLocale}
              lang={otherLocale}
              aria-label={languageLinkLabel}
              className={cx(
                'rounded-lg px-3 py-2 text-sm font-medium text-ink-body',
                'transition-colors duration-200 hover:bg-state-hover hover:text-ink-strong',
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
    <ul className="flex list-none flex-col border-t border-hairline">
      {entries.map((entry) => (
        <li key={entry.href} className="border-b border-hairline">
          <a
            href={entry.href}
            className={cx(
              'block py-3 text-base font-medium text-ink-strong transition-colors duration-150 hover:text-ink-muted',
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
