import { FOCUS_RING_INVERTED, PageContainer, cx } from '@repo/ui';
import type { ReactNode } from 'react';

export interface SiteFooterProps {
  readonly copyright: string;
  /**
   * The composed footer menu, where this surface carries one (0094).
   *
   * Absent on the account and authentication surfaces (owner decision 2), and absent when nothing has been composed
   * or the menus could not be read — in which case this is the footer it has always been (owner decision 7).
   */
  readonly navigation?: ReactNode;
  /** The site's name and the three catalogue doors, so the page always ends somewhere useful. */
  readonly siteName: string;
  readonly locale: 'en' | 'ar';
  readonly labels: { readonly listings: string; readonly services: string; readonly categories: string };
  /** Public surfaces only, exactly as the header's doors are (0094, owner decision 2). */
  readonly publicSurface: boolean;
}

/**
 * The page's close.
 *
 * **Ink, like the page's opening.** A marketplace page that opens on an inverted band and ends on a pale grey
 * one trails off; ending on the same ink closes it. That symmetry is the cheapest structural device there is,
 * and in a palette with no hue it is one of the few that works at all. It is still wayfinding and not a second
 * home page: a name, the doors, whatever an administrator composed, and the copyright.
 *
 * The catalogue doors are repeated here for the same reason they appear in the drawer: they are routes that exist
 * in code, and the bottom of a long scroll is exactly where a person who found nothing wants them. The copyright
 * sits last, in the quietest weight the scale has.
 */
export function SiteFooter({ copyright, navigation, siteName, locale, labels, publicSurface }: SiteFooterProps) {
  const prefix = locale === 'ar' ? '/ar' : '';
  const doors = [
    { href: `${prefix}/listings`, label: labels.listings },
    { href: `${prefix}/services`, label: labels.services },
    { href: `${prefix}/categories`, label: labels.categories },
  ];
  return (
    /*
      The hairline matters when the band above the footer is also ink — a `value_props` section closing the
      home page, for instance. Without it the two run together into one undifferentiated black field and the
      page appears to have no footer at all.
    */
    <footer className="mt-auto border-t border-edge-on-ink bg-surface-ink text-on-ink">
      <PageContainer>
        <div className="flex flex-col gap-12 py-16 sm:py-20">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
            <p className="text-xl font-semibold text-on-ink sm:text-2xl">{siteName}</p>
            {!publicSurface ? null : (
              <nav aria-label={siteName}>
                <ul className="flex list-none flex-wrap gap-x-8 gap-y-3">
                  {doors.map((door) => (
                    <li key={door.href}>
                      <a
                        href={door.href}
                        className={cx(
                          'rounded-sm text-base font-medium text-on-ink-muted transition-colors duration-200 hover:text-on-ink',
                          FOCUS_RING_INVERTED,
                        )}
                      >
                        {door.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
          </div>
          {navigation === undefined ? null : (
            <div className="border-t border-edge-on-ink pt-10">{navigation}</div>
          )}
          <p className="border-t border-edge-on-ink pt-8 text-sm text-on-ink-muted">{copyright}</p>
        </div>
      </PageContainer>
    </footer>
  );
}
