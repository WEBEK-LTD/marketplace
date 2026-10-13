import { designTokens } from '@repo/config';
import type { MetadataRoute } from 'next';

/**
 * The web app manifest, so an installed shortcut carries the brand rather than a screenshot of the page.
 *
 * **The two colours are read from the design tokens, not written here.** `theme_color` is what a phone
 * paints its status bar with and `background_color` is what it shows while the app opens; both are the
 * brand, and a brand written twice is a brand that will one day disagree with itself. `surface.ink` is the
 * owner's emerald at its own lightness and `surface.canvas` is the white they specified, so changing the
 * two slots in `@repo/config` moves this file too, with nothing to remember.
 *
 * The icons are the two Android sizes from the brand's own favicon set, served from `public/`. The proxy
 * passes this address and those files through unrewritten — see `BRAND_PREFIX` and `ICON_ROUTES` there —
 * because a manifest rewritten into a locale is a manifest nothing can fetch.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BedonOver',
    short_name: 'BedonOver',
    start_url: '/',
    display: 'standalone',
    theme_color: designTokens.color.surface.ink,
    background_color: designTokens.color.surface.canvas,
    icons: [
      { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
