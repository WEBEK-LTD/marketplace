import type { ReactNode } from 'react';

export interface SkipLinkProps {
  readonly targetId: string;
  readonly children: ReactNode;
}

/** Keyboard "skip to content" link, visible only when focused. */
export function SkipLink({ targetId, children }: SkipLinkProps) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:rounded-md focus:bg-neutral-0 focus:px-4 focus:py-2 focus:text-neutral-900"
    >
      {children}
    </a>
  );
}
