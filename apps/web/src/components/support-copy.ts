import type { SupportCopy } from './support-views';
import type { AttachmentCopy } from './support-attachment-link';
import type { CloseTicketCopy, OpenTicketCopy, ReplyCopy } from './support-forms';

/**
 * The support surface's words, assembled once (Phase 7-K).
 *
 * The list and the ticket render from the same message keys, so the copy is built here rather than twice.
 *
 * **Only the words a surface needs are built, in the group that uses it.** These become RSC payload, so a
 * group is assembled where it is rendered: the list page builds the list's words and the form's, the ticket
 * page builds the ticket's, the conversation's, the reply form's and the closure's. Nothing ships the words
 * for a control that is not on the page.
 *
 * **The five statuses are labelled, including the two a requester cannot cause.** `resolved` is what an agent
 * records and `open` exists for the length of one transaction, and both are read back honestly rather than
 * hidden — a status with no label would render as its own column value, which is not a sentence in anybody's
 * language.
 */

function failures(t: (key: string) => string): {
  invalid: string;
  notFound: string;
  closed: string;
  missing: string;
  throttled: string;
  signedOut: string;
  unavailable: string;
} {
  return {
    invalid: t('failedInvalid'),
    notFound: t('failedNotFound'),
    closed: t('failedClosed'),
    missing: t('failedMissing'),
    throttled: t('failedThrottled'),
    signedOut: t('failedSignedOut'),
    unavailable: t('failedGeneric'),
  };
}

function categories(t: (key: string) => string): Readonly<Record<string, string>> {
  return {
    account: t('categoryAccount'),
    orders: t('categoryOrders'),
    payments: t('categoryPayments'),
    payouts: t('categoryPayouts'),
    listings: t('categoryListings'),
    verification: t('categoryVerification'),
    technical: t('categoryTechnical'),
    other: t('categoryOther'),
  };
}

export function supportAttachmentCopy(t: (key: string) => string): AttachmentCopy {
  return { ...failures(t), open: t('attachmentOpen'), opening: t('attachmentOpening') };
}

export function supportCopy(
  t: (key: string, values?: Record<string, number>) => string,
): SupportCopy {
  return {
    listLabel: t('listLabel'),
    reference: t('reference'),
    category: t('category'),
    categories: categories(t),
    status: t('status'),
    statuses: {
      open: t('statusOpen'),
      pending_agent: t('statusPendingAgent'),
      pending_requester: t('statusPendingRequester'),
      resolved: t('statusResolved'),
      closed: t('statusClosed'),
    },
    messages: (count: number) => t('messagesCount', { count }),
    files: (count: number) => t('filesCount', { count }),
    opened: t('opened'),
    lastActivity: t('lastActivity'),
    closedAt: t('closedAt'),
    resolvedAt: t('resolvedAt'),
    openTicket: t('openTicket'),
    conversation: t('conversation'),
    you: t('you'),
    agent: t('agent'),
    attachments: t('attachments'),
    olderMessages: t('olderMessages'),
    attachment: supportAttachmentCopy(t),
  };
}

export function openTicketCopy(t: (key: string) => string): OpenTicketCopy {
  return {
    ...failures(t),
    action: t('newAction'),
    heading: t('newHeading'),
    intro: t('newIntro'),
    subjectLabel: t('subjectLabel'),
    categoryLabel: t('categoryLabel'),
    categories: categories(t),
    bodyLabel: t('bodyLabel'),
    filesLabel: t('filesLabel'),
    filesHint: t('filesHint'),
    send: t('newSend'),
    cancel: t('cancel'),
    working: t('working'),
    subjectRequired: t('subjectRequired'),
    subjectTooLong: t('subjectTooLong'),
    bodyRequired: t('bodyRequired'),
    bodyTooLong: t('bodyTooLong'),
    categoryRequired: t('categoryRequired'),
    filesFailed: t('filesFailed'),
    noCredentials: t('noCredentials'),
  };
}

export function replyCopy(t: (key: string) => string): ReplyCopy {
  return {
    ...failures(t),
    label: t('replyLabel'),
    placeholder: t('replyPlaceholder'),
    filesLabel: t('filesLabel'),
    filesHint: t('filesHint'),
    send: t('replySend'),
    sending: t('replySending'),
    bodyRequired: t('bodyRequired'),
    bodyTooLong: t('bodyTooLong'),
    filesFailed: t('filesFailed'),
    closedHint: t('closedHint'),
  };
}

export function closeTicketCopy(t: (key: string) => string): CloseTicketCopy {
  return {
    ...failures(t),
    action: t('closeAction'),
    question: t('closeQuestion'),
    warning: t('closeWarning'),
    confirm: t('closeConfirm'),
    cancel: t('cancel'),
    working: t('working'),
  };
}
