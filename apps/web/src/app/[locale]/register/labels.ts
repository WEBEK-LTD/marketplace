import { getTranslations } from 'next-intl/server';
import type { RegisterLabels } from '../../../components/register-forms';

/**
 * The strings the two registration forms show.
 *
 * They are resolved on the server and passed as props, like every other component in this app: the client
 * bundle is given only the `Error` messages by the root layout.
 */
export async function registerLabels(): Promise<RegisterLabels> {
  const t = await getTranslations('Register');
  return {
    email: t('email'),
    emailHint: t('emailHint'),
    phone: t('phone'),
    phoneHint: t('phoneHint'),
    password: t('password'),
    passwordHint: t('passwordHint'),
    displayName: t('displayName'),
    displayNameHint: t('displayNameHint'),
    code: t('code'),
    codeHint: t('codeHint'),
    submitRegister: t('submitRegister'),
    submitVerify: t('submitVerify'),
    submitResend: t('submitResend'),
    submitting: t('submitting'),
    incomplete: t('incomplete'),
    started: t('started'),
    resent: t('resent'),
    failed: t('failed'),
    invalid: t('invalid'),
    throttled: t('throttled'),
    unavailable: t('unavailable'),
    done: t('done'),
  };
}
