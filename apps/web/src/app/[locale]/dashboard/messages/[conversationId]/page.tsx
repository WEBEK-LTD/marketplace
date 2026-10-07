import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  ConversationControls,
  MessageComposer,
  type ComposerLabels,
  type ControlLabels,
} from '../../../../../components/messaging-composer';
import { BlockPerson } from '../../../../../components/account-actions';
import { blockCopy } from '../../../../../components/block-copy';
import { type AttachmentCopy } from '../../../../../components/messaging-attachments';
import { LiveThread } from '../../../../../components/messaging-live';
import { ReportAction, type ReportCopy } from '../../../../../components/messaging-report';
import {
  MessagingError,
  renderableMessage,
  type MessageLabels,
} from '../../../../../components/messaging-views';
import { RequireSession } from '../../../../../components/require-session';
import { readConversationMessages, readInbox } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Messages');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * One conversation (Phase 5-D read, Phase 5-E write).
 *
 * Opening the page still does **not** mark anything read: that is a write, and 5-E gives it a button
 * rather than doing it behind the person's back. There is no edit, no delete and no reopen control here,
 * because there are no such operations anywhere in the stack.
 *
 * **What the page knows about the conversation itself.** The messages endpoint returns messages, not the
 * conversation, so the heading, the closed state and the listing snapshot come from the caller's own
 * inbox — the same 5-C contract, looked up by id among the conversations they are in. A conversation
 * that is not in their inbox simply contributes nothing here; it never becomes a reason to show or hide
 * the thread, because the messages endpoint has already decided whether they may read it.
 *
 * **How it knows the caller has left.** 0053's inbox lists current memberships only, so a conversation a
 * participant has left is readable but absent from it. Absence alone would be ambiguous — it could just
 * be a later page — so the page treats it as "left" **only when the inbox it read was complete**, which
 * is to say when there was no next cursor. Beyond that the composer stays enabled and the server remains
 * the authority: a refusal is shown in its own words rather than guessed at here.
 *
 * **What it refuses to reveal.** A conversation the caller may not read and one that does not exist both
 * arrive as `not_found`, and both render the same words. The page has no branch that could tell them
 * apart and therefore none that could leak the difference.
 *
 * **Order.** The API hands back a page already in reading order, chosen backwards from the cursor, so it
 * is rendered exactly as received. Re-sorting here would be a second opinion about a settled order.
 *
 * **Catch-up (5-F).** The rendered page is handed to a client component that re-reads the newest page
 * every five seconds while the tab is visible and merges the answer in by message id. It merges rather
 * than replaces, so the older history someone loaded stays on screen; it never touches the "load older"
 * link, so their position in that history is theirs; and it writes nothing at all — opening or watching a
 * thread still does not mark it read. The messages crossing into that component are narrowed to what a
 * message displays, because a client component's props reach the browser and a sender id has no business
 * being there.
 */
export default async function ConversationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale; readonly conversationId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale, conversationId }, query, t, session, blocks] = await Promise.all([
    params,
    searchParams,
    getTranslations('Messages'),
    getTranslations('Session'),
    getTranslations('Blocks'),
  ]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const here = `${prefix}/dashboard/messages/${conversationId}`;
  const cookieHeader = (await headers()).get('cookie');

  const labels: MessageLabels = {
    // 0104. One word per permitted type, so a file reads as "Image" rather than as its MIME string.
    attachments: t('attachments'),
    attachmentTypes: {
      'image/jpeg': t('attachmentTypeImage'),
      'image/png': t('attachmentTypeImage'),
      'image/webp': t('attachmentTypeImage'),
      'application/pdf': t('attachmentTypePdf'),
    },
    kilobytes: t('kilobytes'),
    megabytes: t('megabytes'),
    noMessages: t('noMessages'),
    closed: t('closed'),
    closedHint: t('closedHint'),
    noLongerAvailable: t('noLongerAvailable'),
    system: t('systemMessage'),
    you: t('you'),
    otherParty: t('otherParty'),
    loadOlder: t('loadOlder'),
  };

  // Both reads use the caller's own session; the cursor is passed through exactly as the API issued it.
  const [thread, inbox] = await Promise.all([
    readConversationMessages(conversationId, { cursor }, { cookieHeader }),
    readInbox({ limit: '50' }, { cookieHeader }),
  ]);

  const conversation =
    inbox.kind === 'ok'
      ? (inbox.data.items.find((item) => item.conversationId === conversationId) ?? null)
      : null;

  const heading = conversation?.listingTitleSnapshot ?? t('title');

  // An active membership is always in the inbox, so absence from a *complete* inbox means they left it.
  const inboxComplete = inbox.kind === 'ok' && inbox.data.nextCursor === null;
  const hasLeft =
    conversation === null ? inboxComplete : conversation.membershipState === 'left';
  const isClosed = conversation?.isClosed ?? false;

  // Each surface names its own sentence for every refusal, rather than sharing a map and patching it: a
  // control that reported "Message is too long" for a refused request would be worse than one that said
  // only that it did not work.
  const composerLabels: ComposerLabels = {
    invalid: t('tooLong'),
    signedOut: session('expiredBody'),
    unavailable: t('unavailableConversation'),
    closed: t('closedHint'),
    blocked: t('cannotMessage'),
    throttled: t('sendFailed'),
    failed: t('sendFailed'),
    placeholder: t('composerPlaceholder'),
    send: t('send'),
    sending: t('sending'),
    tooLong: t('tooLong'),
    sendFailed: t('sendFailed'),
    closedHint: t('closedHint'),
    leftHint: t('leftHint'),
    label: t('composerPlaceholder'),
  };

  // 5-H. The refusal sentences a report can produce are the messaging ones it shares with every other
  // write; the rest is the confirmation, which differs only in what it names.
  const reportFailures = {
    invalid: t('reportFailed'),
    signedOut: session('expiredBody'),
    unavailable: t('unavailableConversation'),
    closed: t('reportFailed'),
    blocked: t('reportFailed'),
    throttled: t('reportFailed'),
    failed: t('reportFailed'),
  };

  const messageReportCopy: ReportCopy = {
    ...reportFailures,
    action: t('reportMessage'),
    confirmation: t('reportConfirmMessage'),
    once: t('reportOnce'),
    confirm: t('reportConfirm'),
    cancel: t('reportCancel'),
    working: t('working'),
    done: t('reportDone'),
  };

  const conversationReportCopy: ReportCopy = {
    ...reportFailures,
    action: t('reportConversation'),
    confirmation: t('reportConfirmConversation'),
    once: t('reportOnce'),
    confirm: t('reportConfirm'),
    cancel: t('reportCancel'),
    working: t('working'),
    done: t('reportDone'),
  };

  // 0103. The conversation is the handle: this control names the thread, and which participant that
  // resolves to is decided inside one database function. No account identifier is in these props.
  const blockLabels = blockCopy(blocks);

  // 0104. The words the two attachment controls need, assembled once: a download button per file and an attach
  // button per message of the caller's own. Nothing about a file crosses into either beyond its id and type.
  const attachmentCopy: AttachmentCopy = {
    download: t('download'),
    opening: t('opening'),
    downloadFailed: t('downloadFailed'),
    attach: t('attach'),
    uploading: t('uploading'),
    attached: t('attached'),
    tooLarge: t('attachTooLarge'),
    wrongType: t('attachWrongType'),
    tooMany: t('attachTooMany'),
    attachFailed: t('attachFailed'),
    blocked: t('attachBlocked'),
  };

  const controlLabels: ControlLabels = {
    invalid: t('actionFailed'),
    signedOut: session('expiredBody'),
    unavailable: t('unavailableConversation'),
    closed: t('closedHint'),
    blocked: t('cannotMessage'),
    throttled: t('actionFailed'),
    failed: t('actionFailed'),
    markRead: t('markRead'),
    mute: t('mute'),
    unmute: t('unmute'),
    leave: t('leave'),
    close: t('close'),
    working: t('working'),
    actionFailed: t('actionFailed'),
    groupLabel: t('yourMessages'),
  };

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{heading}</Heading>
          <p className="mt-2">
            <Link
              href={`${prefix}/dashboard/messages`}
              className="text-sm underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900"
            >
              {t('title')}
            </Link>
          </p>

          {thread.kind === 'not_found' || thread.kind === 'invalid' ? (
            // One wording for a conversation that is not theirs and one that does not exist.
            <p role="status" className="mt-8 text-neutral-900">
              {t('unavailableConversation')}
            </p>
          ) : thread.kind !== 'ok' ? (
            <MessagingError title={t('error')} retryLabel={t('retry')} retryHref={here} />
          ) : (
            <section aria-labelledby="conversation-thread">
              <h2 id="conversation-thread" className="sr-only">
                {t('yourMessages')}
              </h2>
              <LiveThread
                conversationId={conversationId}
                attachmentCopy={attachmentCopy}
                initialMessages={thread.data.items.map(renderableMessage)}
                referenceTitle={conversation?.listingTitleSnapshot ?? null}
                isClosed={isClosed}
                olderHref={
                  thread.data.nextCursor === null
                    ? null
                    : `${here}?cursor=${encodeURIComponent(thread.data.nextCursor)}`
                }
                labels={labels}
                reportCopy={messageReportCopy}
              />

              <ConversationControls
                conversationId={conversationId}
                // The page renders oldest-first, so the newest message the caller can see is the last one
                // on this page. The marker only ever moves forward server-side, so naming an older
                // sequence while paging backwards is a no-op rather than a regression.
                latestSeq={thread.data.items.at(-1)?.seq ?? null}
                isMuted={conversation?.isMuted ?? false}
                isClosed={isClosed}
                hasLeft={hasLeft}
                labels={controlLabels}
              />

              {/*
                Reporting the whole conversation sits with the controls, and is deliberately not one of
                them: the four controls change the caller's own relationship to the conversation, and this
                one changes nothing at all — it asks somebody to look.
              */}
              <ReportAction
                subject={{ kind: 'conversation', conversationId }}
                copy={conversationReportCopy}
              />

              {/*
                0103. Blocking sits beside reporting because the two are what somebody reaches for when a
                conversation has gone wrong, and they do different things: a report asks staff to look, a
                block stops contact now and tells nobody. Both stay available on a closed or left thread,
                because that is exactly when somebody may still be being contacted elsewhere.
              */}
              <p className="mt-4">
                <BlockPerson handle={{ conversationId }} copy={blockLabels} />
              </p>

              <MessageComposer
                conversationId={conversationId}
                isClosed={isClosed}
                hasLeft={hasLeft}
                labels={composerLabels}
              />
            </section>
          )}
        </div>
      </PageContainer>
    </RequireSession>
  );
}
