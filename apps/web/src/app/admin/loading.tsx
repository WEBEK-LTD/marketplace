import { getTranslations } from 'next-intl/server';

export default async function Loading() {
  const t = await getTranslations('Loading');
  return (
    <p role="status" className="py-12 text-center text-sm text-neutral-600">
      {t('label')}
    </p>
  );
}
