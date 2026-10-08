import { PageContainer, cx, FOCUS_RING } from '@repo/ui';
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
 * Recessed onto `neutral-50` with a hairline above it, so the end of a long catalogue grid is visibly the end
 * rather than running out of content. That is the whole of the treatment — a footer is wayfinding, not a second
 * home page, and the links in it are an administrator's to compose.
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
    <footer className="mt-auto border-t border-neutral-200 bg-neutral-50">
      <PageContainer>
        <div className="flex flex-col gap-8 py-10">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <p className="text-base font-semibold text-neutral-900">{siteName}</p>
            {!publicSurface ? null : (
            <nav aria-label={siteName}>
              <ul className="flex list-none flex-wrap gap-x-6 gap-y-2">
                {doors.map((door) => (
                  <li key={door.href}>
                    <a
                      href={door.href}
                      className={cx(
                        'rounded-sm text-sm font-medium text-neutral-700 transition-colors duration-150 hover:text-neutral-900 hover:underline hover:underline-offset-2',
                        FOCUS_RING,
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
          {navigation === undefined ? null : <div className="border-t border-neutral-200 pt-8">{navigation}</div>}
          <p className="border-t border-neutral-200 pt-6 text-sm text-neutral-600">{copyright}</p>
        </div>
      </PageContainer>
    </footer>
  );
}
