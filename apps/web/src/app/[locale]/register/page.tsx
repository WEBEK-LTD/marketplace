import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RegisterForm } from '../../../components/register-forms';
import { registerLabels } from './labels';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Register');
  return { title: t('startTitle'), robots: { index: false, follow: false } };
}

/**
 * Step one of registration.
 *
 * The page is a server component that does nothing but translate: it holds no session, reads no cookie and
 * calls no API. The form below it posts to this origin's BFF route, which is the only thing that may talk
 * to the API.
 *
 * It says the same thing to everyone, because the server answers the same way for every address. There is
 * no "this email is taken" state on this page, and no state that could be reached only by an address that
 * is free — which is what makes the promise observable rather than merely documented.
 */
export default async function RegisterPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations('Register');
  const prefix = locale === 'ar' ? '/ar' : '';
  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('startTitle')}</Heading>
        <p className="mt-2 max-w-sm text-ink-muted">{t('startIntro')}</p>
        <RegisterForm
          action="/api/auth/register"
          nextHref={`${prefix}/register/verify`}
          labels={await registerLabels()}
        />
        <p className="mt-8 max-w-sm text-sm text-ink-muted">
          {t('haveAccount')}{' '}
          <Link href={`${prefix}/login`} className="underline">
            {t('signIn')}
          </Link>
        </p>
      </div>
    </PageContainer>
  );
}
