import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TotpSetupForm } from '../../../../admin/components/totp-forms';
import { totpLabels } from './labels';
import { adminApiPath } from '../../../../admin/paths';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Totp');
  return { title: t('setupTitle'), robots: { index: false, follow: false } };
}

/**
 * Setting up an authenticator, on the admin origin.
 *
 * A server component that does nothing but translate: it holds no session, reads no cookie and calls no
 * API. Everything below it posts to this origin's BFF routes, which are the only things that may speak
 * to the API — and the only things that ever hold the factor, the challenge or the new session.
 *
 * **Nothing here is offered to buyers or sellers.** This page exists on the staff origin alone, and no
 * route on the public web app reaches it. A second factor is required of staff roles by the database's
 * own `requires_mfa` rule, which 7-B leaves exactly as it found it; an ordinary account is never asked.
 */
export default async function TotpSetupPage() {
  const t = await getTranslations('Totp');
  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('setupTitle')}</Heading>
        <TotpSetupForm
          enrolAction={adminApiPath('/api/auth/totp/enrol')}
          challengeAction={adminApiPath('/api/auth/totp/challenge')}
          verifyAction={adminApiPath('/api/auth/totp/verify')}
          doneHref="/"
          labels={await totpLabels()}
        />
      </div>
    </PageContainer>
  );
}
