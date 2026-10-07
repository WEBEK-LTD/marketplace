import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TotpChallengeForm } from '../../../../../admin/components/totp-forms';
import { totpLabels } from '../labels';
import { adminApiPath } from '../../../../../admin/paths';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Totp');
  return { title: t('challengeTitle'), robots: { index: false, follow: false } };
}

/**
 * Answering a challenge with an authenticator already set up.
 *
 * This is the step that raises a staff session from `aal1` to `aal2`. It changes nothing about what the
 * person may do — the database decides that, from the role they hold and the assurance level of the
 * token they present — it simply lets them reach the level their role has always required.
 */
export default async function TotpChallengePage() {
  const t = await getTranslations('Totp');
  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('challengeTitle')}</Heading>
        <p className="mt-2 max-w-md text-neutral-600">{t('challengeIntro')}</p>
        <TotpChallengeForm
          challengeAction={adminApiPath('/api/auth/totp/challenge')}
          verifyAction={adminApiPath('/api/auth/totp/verify')}
          doneHref="/"
          labels={await totpLabels()}
        />
      </div>
    </PageContainer>
  );
}
