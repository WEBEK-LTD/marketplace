import { Band, FOCUS_RING_INVERTED, Heading, PageContainer, cx } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import type { PublicLocale } from '@repo/config';
import { SiteSearchForm } from './site-search-form';

/**
 * The home page's opening band (0112).
 *
 * **What this replaced, and why each part of it was wrong.** The band before this one put its content in a
 * `max-w-3xl` column on the inline-start side of a 1440px viewport, which left the other 55% an empty emerald
 * field; above the content floated a 64px accent rule with nothing on it; the `<h1>` was the site's own name,
 * repeated 60 pixels below the logo that had just said it, so the largest type on the front page told a visitor
 * nothing about what the site is for; the subline described a general marketplace; and the search field and its
 * button were two separate white controls of the same height and radius, which on a phone stacked into what read
 * as two empty fields. None of that is a matter of taste — each item is a thing a person looking at the page
 * cannot make sense of.
 *
 * **It is a photographic band.** Property is bought with the eyes, so the opening of a property marketplace is a
 * photograph with the proposition and the search over it. The photograph is one file at one address —
 * `apps/web/public/brand/hero.jpg`, named by `.mp-hero-photo` in `globals.css` and nowhere else — and replacing
 * that file is the whole of changing the picture.
 *
 * **The band is correct with no photograph at all**, which matters because the file is the owner's to supply.
 * The band paints `surface.ink` itself and the photograph is a background layer over it, so the two states are
 * "the brand's emerald" and "the owner's photograph on the brand's emerald", and the composition — the measure,
 * the type scale, where the content sits — is identical in both. A hero whose layout only works once an asset
 * arrives is a hero that is broken until it does.
 *
 * **It is a CSS background and not an `<img>`, and a screenshot is why.** The first build of this band used a
 * decorative `<img alt="">`, on the assumption that a browser draws nothing for a broken decorative image.
 * Chromium draws its broken-image mark, and the mobile screenshot showed it sitting in the corner of the hero on
 * every page load. A background that cannot be fetched paints nothing, in every browser. This is the second
 * defect in two increments that only a screenshot could find.
 *
 * **The scrim is flat, not a gradient**, and that is a decision rather than a limitation. The photograph is
 * supplied by the owner and may be bright, dark, busy or empty in any corner, so the only overlay that can be
 * guaranteed to keep white type legible over it is a uniform one. A gradient would also put colour stops into the
 * shipped stylesheet that came from no token, which `http.test.ts` forbids for exactly that reason.
 *
 * **70% is the number, and it is chosen rather than eyeballed.** The worst case a photograph can present is a
 * pure white region behind the text. Compositing `#123B35` at 0.70 over white gives a relative luminance of
 * 0.161, so white type on it is 4.94:1 — above the 4.5:1 that body text needs, against the brightest image that
 * could ever be dropped in. At 0.65 the same case is 4.28:1 and at 0.60 it is 3.72:1, which is why the scrim is
 * not lighter however much more of the photograph a lighter one would show.
 *
 * **The content sits at the foot of the band.** The photograph gets the upper two thirds and the words settle
 * against the bottom edge, which is the composition a property hero actually wants: you see the building, then
 * you read the offer, then your hand is already at the search bar. Centring the stack was the alternative and is
 * the layout every generated page arrives at.
 *
 * **Two doors, not three.** `/services` stays in the header drawer and the footer, where it has always been, and
 * is deliberately not offered here: the V1 catalogue is property only (OD-A9), and a front page that invites a
 * visitor to "find a service" is pointing at a shelf this release does not stock. Nothing is deleted — that is
 * 1b's work — but the home page stops advertising it.
 *
 * **On the copy.** Before this increment the page refused to write a word of its own, on the grounds that it
 * composes what an administrator arranged. The owner has since asked for a front page that explains the service,
 * so it now carries two lines — and both are derived from approved decisions rather than invented: the payment
 * and the paperwork happen at the office (OD-A1), and a buyer deals with the office team rather than with a
 * seller (OD-A4). Everything below this band is still composed.
 */

export async function HomeHero({ locale, language }: { readonly locale: string; readonly language: PublicLocale }) {
  const t = await getTranslations({ locale, namespace: 'Homepage' });
  const search = await getTranslations({ locale, namespace: 'Search' });
  const prefix = language === 'ar' ? '/ar' : '';

  const doors = [
    { href: `${prefix}/listings`, label: t('browseListings') },
    { href: `${prefix}/categories`, label: t('browseCategories') },
  ];

  return (
    <Band tone="ink" space="opening" as="div" className="relative isolate overflow-hidden">
      {/*
        The photograph, and then the scrim over it. Both are decorative layers behind the content: the first
        paints `public/brand/hero.jpg` if it is there and nothing if it is not, the second is the flat overlay
        that keeps white type legible over whatever that photograph turns out to be.
      */}
      <span aria-hidden="true" className="mp-hero-photo absolute inset-0 -z-20" />
      <span aria-hidden="true" className="absolute inset-0 -z-10 bg-surface-ink/70" />

      <PageContainer>
        <div className="flex min-h-[22rem] flex-col justify-end sm:min-h-[26rem] lg:min-h-[30rem]">
          <Heading level={1} display className="max-w-4xl text-on-ink">
            {t('heroTitle')}
          </Heading>
          <p className={cx('mt-6 max-w-2xl text-lg leading-normal text-on-ink sm:text-xl')}>{t('heroLead')}</p>

          <div className="mt-10">
            <SiteSearchForm
              action={`${prefix}/search`}
              placeholder={search('placeholder')}
              submitLabel={search('submit')}
              id="home-search"
              tone="ink"
              shape="fused"
            />
          </div>

          {/*
            The doors under the bar, as two quiet pills. They are secondary to the search — a visitor who knows
            what they want types it — so they are sized and weighted as what they are: shortcuts, not a menu.
          */}
          <ul className="mt-7 flex list-none flex-wrap gap-2.5">
            {doors.map((door) => (
              <li key={door.href}>
                <a
                  href={door.href}
                  className={cx(
                    'group inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-on-ink',
                    'bg-surface-ink-muted ring-1 ring-edge-on-ink transition-colors duration-200',
                    'hover:bg-state-hover-on-ink hover:ring-edge-on-ink-strong',
                    FOCUS_RING_INVERTED,
                  )}
                >
                  {door.label}
                  <span
                    aria-hidden="true"
                    className="size-1.5 -rotate-45 rtl:rotate-45 border-e border-b border-on-ink transition-transform duration-200 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5"
                  />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </PageContainer>
    </Band>
  );
}
