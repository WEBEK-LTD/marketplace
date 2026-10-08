import type { ReactNode } from 'react';
import { TYPE } from './recipes.js';

export interface HeadingProps {
  readonly level: 1 | 2 | 3 | 4;
  readonly children: ReactNode;
  readonly id?: string;
  /**
   * Render at the display size while keeping the semantic level.
   *
   * The home page's opening line is an `h1` that is visually much larger than every other `h1` in the product.
   * Separating the two means the document outline stays correct without the type scale having to follow it —
   * which is the usual reason a page ends up with an `h3` chosen for its size.
   */
  readonly display?: boolean;
  readonly className?: string;
}

const LEVELS = { 1: TYPE.h1, 2: TYPE.h2, 3: TYPE.h3, 4: TYPE.h4 } as const;

/** A semantic heading at the shared type scale. */
export function Heading({ level, children, id, display = false, className }: HeadingProps) {
  const Tag = `h${level}` as const;
  const classes = [display ? TYPE.display : LEVELS[level], className].filter((part) => typeof part === 'string' && part !== '').join(' ');
  return (
    <Tag id={id} className={classes}>
      {children}
    </Tag>
  );
}
