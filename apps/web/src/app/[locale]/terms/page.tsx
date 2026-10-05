import type { Metadata } from 'next';
import {
  cmsStaticPageMetadata,
  renderCmsStaticPage,
  type CmsStaticPageParams,
} from '../../../components/cms-static-page';

/**
 * `/terms` and `/ar/terms` — the CMS static page at this address.
 *
 * One of the static addresses the specification's route map fixes. Everything this page says is authored in
 * the admin console and read from the database; `src/server/cms-static-page.tsx` holds the rendering, the
 * metadata and the four outcomes, and `@repo/config` holds the list of addresses this app serves.
 */
const SLUG = 'terms' as const;

export async function generateMetadata({ params }: CmsStaticPageParams): Promise<Metadata> {
  const { locale } = await params;
  return cmsStaticPageMetadata(SLUG, locale);
}

export default async function TermsPage({ params }: CmsStaticPageParams) {
  const { locale } = await params;
  return renderCmsStaticPage(SLUG, locale);
}
