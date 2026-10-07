import { getTranslations } from 'next-intl/server';
import type { TotpLabels } from '../../../../admin/components/totp-forms';

/**
 * The strings the two TOTP forms show.
 *
 * Resolved on the server and passed as props, like every other component in this app: the client bundle
 * is given only the `Error` messages by the root layout.
 */
export async function totpLabels(): Promise<TotpLabels> {
  const t = await getTranslations('Totp');
  return {
    setupIntro: t('setupIntro'),
    scanHeading: t('scanHeading'),
    scanHint: t('scanHint'),
    qrAlt: t('qrAlt'),
    secretHeading: t('secretHeading'),
    secretHint: t('secretHint'),
    codeLabel: t('codeLabel'),
    codeHint: t('codeHint'),
    begin: t('begin'),
    submitVerify: t('submitVerify'),
    submitting: t('submitting'),
    incomplete: t('incomplete'),
    failed: t('failed'),
    invalid: t('invalid'),
    alreadyEnrolled: t('alreadyEnrolled'),
    notEnrolled: t('notEnrolled'),
    throttled: t('throttled'),
    unavailable: t('unavailable'),
    done: t('done'),
  };
}
