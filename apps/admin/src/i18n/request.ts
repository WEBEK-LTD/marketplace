import { getRequestConfig } from 'next-intl/server';
import { resolveAdminLocale } from './locale';

export default getRequestConfig(async () => {
  const locale = await resolveAdminLocale();
  const messages = (await import(`../../messages/${locale}.json`)).default as Record<string, unknown>;
  return { locale, messages };
});
