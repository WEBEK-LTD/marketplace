import type { BlockCopy } from './account-actions';

/**
 * The block control's words, assembled once (0103).
 *
 * The same control appears on two pages — a conversation and a seller storefront — so its copy is built here
 * rather than twice. These become RSC payload, which is why only the seven words this control needs are
 * assembled and nothing about the person being blocked is among them: the control holds a handle and these
 * labels, and that is the whole of what reaches the browser.
 */
export function blockCopy(t: (key: string) => string): BlockCopy {
  return {
    block: t('block'),
    confirm: t('blockConfirm'),
    cancel: t('blockCancel'),
    explain: t('blockExplain'),
    working: t('working'),
    done: t('blockDone'),
    failed: t('blockFailed'),
    signIn: t('signIn'),
  };
}
