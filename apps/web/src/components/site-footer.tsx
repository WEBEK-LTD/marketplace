import { PageContainer } from '@repo/ui';
import type { ReactNode } from 'react';

export interface SiteFooterProps {
  readonly copyright: string;
  /**
   * The composed footer menu, where this surface carries one (0094).
   *
   * Absent on the account and authentication surfaces (owner decision 2), and absent when nothing has been composed
   * or the menus could not be read — in which case this is exactly the footer it has always been (owner decision 7).
   */
  readonly navigation?: ReactNode;
}

export function SiteFooter({ copyright, navigation }: SiteFooterProps) {
  return (
    <footer className="mt-auto border-t border-neutral-200">
      <PageContainer>
        {navigation === undefined ? null : <div className="pt-8">{navigation}</div>}
        <p className="py-6 text-sm text-neutral-600">{copyright}</p>
      </PageContainer>
    </footer>
  );
}
