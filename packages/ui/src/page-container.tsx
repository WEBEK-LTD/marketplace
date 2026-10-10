import type { ReactNode } from 'react';
import { cx } from './recipes.js';

export interface PageContainerProps {
  readonly children: ReactNode;
  readonly as?: 'div' | 'main' | 'header' | 'footer' | 'section';
  /** `narrow` is for reading: a single column of prose, an auth form, a policy page. */
  readonly width?: 'default' | 'narrow';
  readonly id?: string;
  readonly className?: string;
}

/**
 * The page's measure.
 *
 * Widened in 0110 from `max-w-6xl` (72rem) to 80rem. On a 1440px screen the old measure left a quarter of the
 * viewport empty down the inline-end edge while the catalogue squeezed four cards into 1152px, which read as an
 * unfinished page rather than as a composed one. The gutters grow with the viewport too, so the content is
 * inset rather than jammed against the edge on a laptop.
 *
 * `narrow` is the reading measure, and it is a different thing from a small page: prose wants roughly 65–75
 * characters a line whatever the screen is, so a policy page or a sign-in form is centred at 42rem rather than
 * stretched across the full width.
 *
 * Padding is logical, so the inset mirrors in Arabic without a second rule.
 */
export function PageContainer({ children, as: Tag = 'div', width = 'default', id, className }: PageContainerProps) {
  return (
    <Tag
      id={id}
      className={cx(
        'mx-auto w-full px-5 sm:px-8 lg:px-12',
        width === 'narrow' ? 'max-w-2xl' : 'max-w-[80rem]',
        className,
      )}
    >
      {children}
    </Tag>
  );
}
