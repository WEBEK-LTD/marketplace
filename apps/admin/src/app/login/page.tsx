import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LoginForm } from '../../components/login-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Login');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The admin sign-in screen, on the admin origin.
 *
 * Nothing here is shared with the public web app: a separate page, a separate form, a separate BFF
 * route and — the part that matters — a separate pair of `__Host-mp_admin_*` cookies. Role checks stay
 * where they already are, on the API side; this screen adds none and relaxes none.
 */
export default async function AdminLoginPage() {
  const t = await getTranslations('Login');
  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('title')}</Heading>
        <LoginForm
          action="/api/auth/login"
          successHref="/"
          labels={{
            identifier: t('identifier'),
            identifierHint: t('identifierHint'),
            password: t('password'),
            submit: t('submit'),
            submitting: t('submitting'),
            incomplete: t('incomplete'),
            failed: t('failed'),
            invalid: t('invalid'),
            throttled: t('throttled'),
            unavailable: t('unavailable'),
          }}
        />
      </div>
    </PageContainer>
  );
}
