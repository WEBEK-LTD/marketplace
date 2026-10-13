import { cx } from './recipes.js';

/**
 * The brand lockup: the icon and the bilingual wordmark, side by side.
 *
 * **Why it is assembled here rather than used as one file.** The supplied horizontal lockup carries the
 * tagline — `REAL ESTATE — بدون أوفر` — on a second line beneath the wordmark. At the size a header gives a
 * logo, around 36 to 40 pixels tall, that line renders about five pixels high: not small, *illegible*, and a
 * row of grey mush under a brand name reads as a rendering fault rather than as a tagline. So the two
 * supplied files that do survive that size are placed next to each other, unaltered: the icon at its own
 * square, the wordmark beside it with both scripts legible. Nothing is redrawn and nothing is recoloured —
 * these are the brand's own files, in the pairing the brand's own horizontal lockup already uses.
 *
 * The full lockup with its tagline stays in `public/brand/` for the places that have room for it.
 *
 * **Two tones, because there is one brand on two grounds.** On a light surface the icon is the emerald
 * square with a white house and the wordmark is emerald. On an ink surface — the footer, the console's
 * masthead — the square becomes an outline and both go white. A single file tinted with CSS would not do
 * it: the icon is a filled square on one and an outline on the other, which is a different drawing.
 *
 * **Why a plain `<img>` and not `next/image`.** The asset is an SVG. Next's image optimiser refuses SVG
 * unless `dangerouslyAllowSVG` is set, and setting that to render the one asset we control would widen what
 * the whole application will render for the sake of a logo. An `<img>` with explicit dimensions costs no
 * layout shift and no second request beyond the file itself. This package carries no Next lint plugin, so
 * there is no rule here to silence — the reasoning is recorded rather than suppressed.
 *
 * **One accessible name, not three.** The icon and the wordmark are both `aria-hidden`; the link or element
 * around them carries the name. A screen reader that heard "BedonOver BedonOver" would be hearing the same
 * brand twice because a sighted reader sees it once.
 */

export type BrandTone = 'light' | 'ink';

const SOURCES = Object.freeze({
  light: { icon: '/brand/icon-green.svg', wordmark: '/brand/wordmark-color.svg' },
  ink: { icon: '/brand/icon-outline-white.svg', wordmark: '/brand/wordmark-white.svg' },
});

export interface BrandLockupProps {
  readonly tone: BrandTone;
  /** Rendered height of the icon. The wordmark is scaled to sit with it. */
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

const ICON = { sm: 'h-8 w-8', md: 'h-9 w-9 sm:h-10 sm:w-10' } as const;
/** Taller than the icon on purpose: the wordmark's own file carries padding above and below its letters. */
const WORDMARK = { sm: 'h-9', md: 'h-10 sm:h-11' } as const;

export function BrandLockup({ tone, size = 'md', className }: BrandLockupProps) {
  const source = SOURCES[tone];
  return (
    <span aria-hidden="true" className={cx('flex shrink-0 items-center gap-2.5', className)}>
      <img src={source.icon} alt="" width={120} height={120} className={ICON[size]} />
      <img src={source.wordmark} alt="" width={632} height={280} className={cx(WORDMARK[size], 'w-auto')} />
    </span>
  );
}
