import type { ReactNode } from 'react';
import { cx } from './recipes.js';

export type BadgeTone = 'neutral' | 'solid' | 'outline';

/**
 * The three badge tones, and why there are only three.
 *
 * A marketplace badge says one of a small number of things: this listing is promoted, this seller is verified,
 * this item is sold, this request is open. In a palette with no hue those distinctions cannot be carried by
 * colour, so they are carried by **fill**: a quiet grey chip for a fact, a filled dark chip for something the
 * platform is asserting (verified, promoted), and an outline for a state that has ended (sold, closed, expired).
 *
 * That is three levels of loudness, which is as many as a badge can usefully have. A fourth would be decoration.
 */
const TONES: Record<BadgeTone, string> = {
  neutral: 'border-transparent bg-surface-muted text-ink-body',
  solid: 'border-edge-strong bg-surface-ink text-on-ink',
  outline: 'border-edge bg-surface-raised text-ink-muted',
};

export interface BadgeProps {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
  /** An icon or dot before the label. Decorative only — the label always carries the meaning. */
  readonly icon?: ReactNode;
  readonly className?: string;
}

/**
 * A short, non-interactive label.
 *
 * Pill-shaped — `rounded-full` is the system's third radius and it belongs to exactly this and {@link Avatar},
 * which is what keeps a badge from reading as a small button. Sentence case, never all caps: a tracked-out
 * uppercase chip is a design cliché, and in Arabic, which has no case, it would simply be a size change.
 */
export function Badge({ children, tone = 'neutral', icon, className }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {icon === undefined ? null : (
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}
