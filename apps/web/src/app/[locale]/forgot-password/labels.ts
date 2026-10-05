import { getTranslations } from 'next-intl/server';
import type { RecoveryLabels } from '../../../components/recovery-forms';

/**
 * The strings the three recovery forms show.
 *
 * They are resolved on the server and passed as props, like every other component in this app: the
 * client bundle is given only the `Error` messages by the root layout.
 */
export async function recoveryLabels(): Promise<RecoveryLabels> {
  const t = await getTranslations('Recovery');
  return {
    identifier: t('identifier'),
    identifierHint: t('identifierHint'),
    code: t('code'),
    codeHint: t('codeHint'),
    newPassword: t('newPassword'),
    newPasswordHint: t('newPasswordHint'),
    submitStart: t('submitStart'),
    submitVerify: t('submitVerify'),
    submitReset: t('submitReset'),
    submitting: t('submitting'),
    incomplete: t('incomplete'),
    started: t('started'),
    failed: t('failed'),
    invalid: t('invalid'),
    throttled: t('throttled'),
    unavailable: t('unavailable'),
    done: t('done'),
  };
}
