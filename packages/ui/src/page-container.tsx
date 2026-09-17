import type { ReactNode } from 'react';

export interface PageContainerProps {
  readonly children: ReactNode;
  readonly as?: 'div' | 'main' | 'header' | 'footer' | 'section';
  readonly id?: string;
}

/** Centred, responsive content width with logical (RTL-safe) padding. */
export function PageContainer({ children, as: Tag = 'div', id }: PageContainerProps) {
  return (
    <Tag id={id} className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
      {children}
    </Tag>
  );
}
