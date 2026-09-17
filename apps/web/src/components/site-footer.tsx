import { PageContainer } from '@repo/ui';

export interface SiteFooterProps {
  readonly copyright: string;
}

export function SiteFooter({ copyright }: SiteFooterProps) {
  return (
    <footer className="mt-auto border-t border-neutral-200">
      <PageContainer>
        <p className="py-6 text-sm text-neutral-600">{copyright}</p>
      </PageContainer>
    </footer>
  );
}
