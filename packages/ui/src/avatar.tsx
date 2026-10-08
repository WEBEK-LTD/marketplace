import { cx } from './recipes.js';

export type AvatarSize = 'sm' | 'md' | 'lg';

const SIZES: Record<AvatarSize, string> = {
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-16 text-lg',
};

export interface AvatarProps {
  /** The name the avatar stands for, which is also what a screen reader hears. */
  readonly name: string;
  readonly size?: AvatarSize;
  readonly className?: string;
}

/**
 * A seller's or a person's mark.
 *
 * **The fallback is the first character of the name, and that has to be script-aware.** `name.charAt(0)` splits
 * a surrogate pair and an Arabic name's first grapheme is not always its first code unit, so the initial is taken
 * with `Intl.Segmenter` where the runtime has it and by code point otherwise. An avatar showing half a character
 * is worse than showing none.
 *
 * The initial is `aria-hidden` and the name is given to the element instead: a screen reader should hear the
 * seller's name, not the letter "م".
 *
 * No generated colour from a name hash. That is the usual fallback trick and it needs a palette this product does
 * not have; a neutral chip with a hairline is honest and stays correct when the brand colours arrive.
 *
 * **There is no image branch, on purpose.** Nothing in V1 supplies an avatar URL: `PublicSellerProfile` has no
 * media field, and neither does any other read contract that reaches this component. A `src` prop would be dead
 * code inviting an `<img>` into a package that is deliberately framework-agnostic — it cannot reach for
 * `next/image`, so it would ship the unoptimised tag the apps' own lint rule forbids. When a contract grows an
 * avatar, the app that reads it renders the image and this component keeps being the fallback.
 */
export function Avatar({ name, size = 'md', className }: AvatarProps) {
  const shell = cx(
    'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-neutral-200 bg-neutral-100',
    SIZES[size],
    className,
  );
  return (
    <span className={shell} role="img" aria-label={name}>
      <span aria-hidden="true" className="font-medium text-neutral-600">
        {firstGrapheme(name)}
      </span>
    </span>
  );
}

/**
 * The first user-perceived character of a name.
 *
 * `Intl.Segmenter` is the correct tool and exists in every runtime this product targets; the fallback is by code
 * point rather than by code unit, so an emoji or an astral character still comes out whole.
 */
export function firstGrapheme(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const Segmenter = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment: (input: string) => Iterable<{ segment: string }> } }).Segmenter;
  if (typeof Segmenter === 'function') {
    for (const { segment } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)) return segment;
  }
  return [...trimmed][0] ?? '';
}
