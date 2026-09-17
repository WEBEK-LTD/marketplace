import type { ReactNode } from 'react';

export interface HeadingProps {
  readonly level: 1 | 2 | 3;
  readonly children: ReactNode;
  readonly id?: string;
}

const SIZES = { 1: 'text-3xl', 2: 'text-2xl', 3: 'text-xl' } as const;

/** Semantic heading with the shared type scale. */
export function Heading({ level, children, id }: HeadingProps) {
  const Tag = `h${level}` as const;
  return (
    <Tag id={id} className={`${SIZES[level]} font-semibold text-neutral-900`}>
      {children}
    </Tag>
  );
}
