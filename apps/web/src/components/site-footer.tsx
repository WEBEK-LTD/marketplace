import { FOCUS_RING_INVERTED, PageContainer, cx } from '@repo/ui';
import type { PublicOfficeContact } from '@repo/contracts';
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
  readonly labels: {
    readonly listings: string;
    readonly services: string;
    readonly categories: string;
    /** The heading over the catalogue column, and the one over the policy row. */
    readonly browseHeading: string;
    readonly legalHeading: string;
    readonly terms: string;
    readonly privacy: string;
    readonly cookies: string;
    readonly help: string;
    readonly contact: string;
    /** One line under the lockup saying what the site is. The site's own description, not new copy. */
    readonly tagline: string;
    /** The heading over the office's own details. */
    readonly officeHeading: string;
    readonly telephoneLabel: string;
    readonly whatsappLabel: string;
    readonly emailLabel: string;
    readonly hoursLabel: string;
  };
  /**
   * The office's own contact details, where the office has set any (0113).
   *
   * Every field is optional and an absent one means unset rather than empty — see `PublicOfficeContactSchema`.
   * The column below renders exactly the fields that arrived, so a site that has filled in a telephone number
   * and nothing else shows a telephone number and nothing else, with no gaps and no placeholder rows.
   */
  readonly office?: PublicOfficeContact;
  /** Public surfaces only, exactly as the header's doors are (0094, owner decision 2). */
  readonly publicSurface: boolean;
}

/**
 * The page's close (rebuilt in 0112).
 *
 * **The defect this fixes is that the page had no visible end.** The footer was `surface.ink` and so was the band
 * above it — a `value_props` section closing the home page is ink by design — with a one-pixel hairline between
 * them. The result was roughly seven hundred pixels of unbroken emerald in which a reader could not see where the
 * content stopped and the footer started. A hairline divides two regions *inside* one surface; saying "the page
 * ends here" needs a change of value, which is what `surface.inkDeep` is for. The footer is now the brand at the
 * darkest step the scale has, and the band above it reads as sitting on top of it.
 *
 * **It is columns, not a row.** Before this it was the lockup on one side and three links on the other, in one
 * flat line: no grouping, no headings, nothing a person scanning for "terms" or "contact" could aim at. Now the
 * code-level columns — the catalogue, and the pages the specification's route map fixes — have headings of their
 * own, so the footer has a structure whether or not an operator has composed anything into it.
 *
 * **The full lockup goes here**, with its `REAL ESTATE — بدون أوفر` tagline, which is the one place in the
 * product that has the room for it. `BrandLockup` exists precisely because that tagline renders about five pixels
 * tall at header size; at the foot of a page, at 56 pixels, it is legible and it is the brand as the brand drew
 * it. So the footer uses the supplied horizontal file directly rather than the assembled pair.
 *
 * **The policy links are code, not composition**, and that is the same decision owner decision 8 makes about the
 * locale switch: these are addresses that exist in the route map whatever an administrator arranges, and the
 * bottom of a page is where a visitor looks for them. The composed footer menu remains the mechanism for
 * everything else — company columns, offices, social accounts — and renders above them.
 */
export function SiteFooter({ copyright, navigation, siteName, locale, labels, office, publicSurface }: SiteFooterProps) {
  const prefix = locale === 'ar' ? '/ar' : '';
  const doors = [
    { href: `${prefix}/listings`, label: labels.listings },
    { href: `${prefix}/categories`, label: labels.categories },
    { href: `${prefix}/services`, label: labels.services },
  ];
  // Addresses the specification's route map fixes, in the order a person looks for them.
  const policies = [
    { href: `${prefix}/help`, label: labels.help },
    { href: `${prefix}/contact`, label: labels.contact },
    { href: `${prefix}/terms`, label: labels.terms },
    { href: `${prefix}/privacy`, label: labels.privacy },
    { href: `${prefix}/cookies`, label: labels.cookies },
  ];

  const link = cx(
    'rounded-sm text-sm text-on-ink-muted transition-colors duration-200 hover:text-on-ink',
    FOCUS_RING_INVERTED,
  );
  /* The column heading: the label step of the shared scale, in the inverted text role. */
  const heading = 'text-sm font-semibold leading-snug text-on-ink';
  // Whether the office has set anything at all. An office with no details gets no column rather than an empty
  // one, which is the same rule every field inside the column follows.
  const hasOffice = office !== undefined && Object.keys(office).length > 0;

  return (
    <footer aria-label={siteName} className="mt-auto bg-surface-ink-deep text-on-ink">
      <PageContainer>
        <div className="flex flex-col gap-12 py-14 sm:py-16">
          {/*
            The lockup and the two code-level columns. The lockup takes its own column on a wide viewport and the
            full width on a phone, where a 56px mark beside a list of links would squeeze both.
          */}
          <div
            className={cx(
              'grid gap-10 sm:grid-cols-2 lg:gap-12',
              /*
                The brand column is wide while there are three columns beside nothing, and even once the office
                column arrives. Stated as two layouts rather than one flexible grid because the brand column
                holds a 56px mark and a short line: given a quarter of 1232px it reads as a column, given a
                third of it, it reads as a hole — which is the defect the tagline was added to fix in 0112.
              */
              hasOffice
                ? 'lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]'
                : 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]',
            )}
          >
            <div>
              {/*
                The brand's own horizontal lockup, tagline and all. `aria-hidden` because the footer's landmark
                and the copyright line already name the site; a third announcement of it would be noise.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element -- an SVG we own; see BrandLockup's note. */}
              <img
                src="/brand/horizontal-white.svg"
                alt=""
                aria-hidden="true"
                width={1024}
                height={420}
                className="h-14 w-auto sm:h-16"
              />
              {/*
                One line under the mark. Without it the brand column was a 56px image above two hundred pixels
                of nothing, because the row's height is set by the five-item policy list beside it — the
                screenshot showed a footer with a hole in its first column. The line is the site's own
                description, which already exists as the home page's meta description; nothing new is written
                here.
              */}
              <p className="mt-5 max-w-xs text-sm leading-relaxed text-on-ink-muted">{labels.tagline}</p>
            </div>

            {!publicSurface ? null : (
              <nav aria-label={labels.browseHeading}>
                <h2 className={heading}>{labels.browseHeading}</h2>
                <ul className="mt-4 flex list-none flex-col gap-3">
                  {doors.map((door) => (
                    <li key={door.href}>
                      <a href={door.href} className={link}>
                        {door.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            )}

            {!publicSurface ? null : (
              <nav aria-label={labels.legalHeading}>
                <h2 className={heading}>{labels.legalHeading}</h2>
                <ul className="mt-4 flex list-none flex-col gap-3">
                  {policies.map((policy) => (
                    <li key={policy.href}>
                      <a href={policy.href} className={link}>
                        {policy.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            )}

            {/*
              The office's own details (0113), and **only the ones it has set**. There is no placeholder row and
              no "not provided": a field the office has not filled in is absent from the data and absent from
              the page, so this column is complete at every stage of being filled in rather than correct only
              once all of it is.

              A description list, because that is what these are — a label and its value — and because it is
              what lets a screen reader announce "Telephone, 02 1234 5678" rather than two unrelated strings.
              The telephone and the email are links: on a phone the single most useful thing in a property
              office's footer is a number you can press.
            */}
            {!publicSurface || !hasOffice ? null : (
              <div>
                <h2 className={heading}>{labels.officeHeading}</h2>
                <dl className="mt-4 flex list-none flex-col gap-3 text-sm">
                  {office?.telephone === undefined ? null : (
                    <div>
                      <dt className="text-on-ink-muted">{labels.telephoneLabel}</dt>
                      <dd className="mt-0.5">
                        {/* `dir="ltr"` on the number: a telephone number reads left to right in both scripts. */}
                        <a href={`tel:${office.telephone.replace(/[^+0-9]/g, '')}`} dir="ltr" className={cx('text-on-ink', link)}>
                          {office.telephone}
                        </a>
                      </dd>
                    </div>
                  )}
                  {office?.whatsapp === undefined ? null : (
                    <div>
                      <dt className="text-on-ink-muted">{labels.whatsappLabel}</dt>
                      <dd className="mt-0.5" dir="ltr">
                        {office.whatsapp}
                      </dd>
                    </div>
                  )}
                  {office?.email === undefined ? null : (
                    <div>
                      <dt className="text-on-ink-muted">{labels.emailLabel}</dt>
                      <dd className="mt-0.5">
                        <a href={`mailto:${office.email}`} dir="ltr" className={cx('break-all text-on-ink', link)}>
                          {office.email}
                        </a>
                      </dd>
                    </div>
                  )}
                  {office?.address === undefined ? null : (
                    <div>
                      <dt className="sr-only">{labels.officeHeading}</dt>
                      {/* The author's line breaks are the address's own shape, so they are kept. */}
                      <dd className="whitespace-pre-line text-on-ink-muted">{office.address}</dd>
                    </div>
                  )}
                  {office?.hours === undefined ? null : (
                    <div>
                      <dt className="text-on-ink-muted">{labels.hoursLabel}</dt>
                      <dd className="mt-0.5 text-on-ink-muted">{office.hours}</dd>
                    </div>
                  )}
                </dl>
                {office?.socialLinks === undefined ? null : (
                  <ul className="mt-5 flex list-none flex-wrap gap-x-5 gap-y-2">
                    {office.socialLinks.map((social) => (
                      <li key={social.url}>
                        {/*
                          `rel="noreferrer"` on an address the office typed into a settings field: it leaves
                          this origin and nothing about the page it left needs to travel with it.
                        */}
                        <a href={social.url} rel="noreferrer" className={link}>
                          {social.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Whatever an operator composed, below the columns that exist in code and above the copyright. */}
          {navigation === undefined ? null : (
            <div className="border-t border-edge-on-ink pt-10">{navigation}</div>
          )}

          <p className="border-t border-edge-on-ink pt-8 text-sm text-on-ink-muted">{copyright}</p>
        </div>
      </PageContainer>
    </footer>
  );
}
