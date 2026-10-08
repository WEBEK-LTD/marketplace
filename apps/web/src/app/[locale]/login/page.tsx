import { Heading, LINK, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { LoginForm } from '../../../components/login-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Login');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The sign-in screen.
 *
 * The page is a server component that does nothing but translate: it holds no session, reads no cookie
 * and calls no API. The form below it posts to this origin's BFF route, which is the only component
 * that may exchange credentials for a session.
 */
export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations('Login');
  return (
    <PageContainer>
      {/*
        An authentication surface is one task, so it is given one column at a readable width and centred in the
        viewport rather than laid out across the page. It carries no composed navigation (0094, owner decision 2),
        which is why a wide column here would leave the form alone on an empty expanse.
      */}
      <div className="mx-auto w-full max-w-sm py-16">
        <Heading level={1}>{t('title')}</Heading>
        <div className="mt-8">
        <LoginForm
          action="/api/auth/login"
          successHref={locale === 'ar' ? '/ar' : '/'}
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
        {/* Phase 7-A: the way in for somebody who has no account yet. A link and nothing more — this page
            still reads no cookie and calls no API. */}
        <p className="mt-8 border-t border-neutral-200 pt-6 text-sm text-neutral-600">
          {t('noAccount')}{' '}
          <Link href={locale === 'ar' ? '/ar/register' : '/register'} className={LINK}>
            {t('createAccount')}
          </Link>
        </p>
      </div>
    </PageContainer>
  );
}
