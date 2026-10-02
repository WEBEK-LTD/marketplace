'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  SUPPORT_ATTACHMENT_ACCEPT,
  SUPPORT_ATTACHMENTS_PER_MESSAGE,
  SUPPORT_BODY_MAX_LENGTH,
  SUPPORT_CATEGORIES,
  SUPPORT_SUBJECT_MAX_LENGTH,
  closeSupportTicket,
  isSupportCategory,
  openSupportTicket,
  postSupportMessage,
  prepareText,
  runSupportAttachmentUpload,
  supportFailureMessage,
  type SupportFailureLabels,
} from './support';

/**
 * The three requester forms (Phase 7-K).
 *
 * All three are thin: every rule they follow lives in `support.ts`, which is what the suite tests, and what
 * remains here is state and markup. What they deliberately do **not** contain is as important:
 *
 * - **No status, no priority, no assignee and no author.** There is no control for any of them, and no field
 *   in what these forms send. `resolved` appears nowhere: ending a ticket is one button with one meaning.
 * - **No destination.** The file input hands bytes to `support.ts`, which asks the server where they go. No
 *   path, bucket or file name is composed in this file.
 * - **No optimistic row.** A draft is cleared and the page refreshed only after the server has confirmed;
 *   anything else leaves the text where it is, says what happened and re-enables the button. Somebody who
 *   lost a paragraph to a failed request has lost more than the request.
 * - **No identifiers on screen.** Nothing here renders an account, and the words for a refusal are the ones
 *   the page passed in — never a sentence the server composed.
 *
 * Files are attached after the message they belong to exists, because that is what the schema says an
 * attachment hangs off. A person sees one action; it happens in three steps, and a file that fails to upload
 * is reported without the message being lost.
 */

const BUTTON_CLASS =
  'rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-60';
const FIELD_CLASS =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900';

/** What a chosen file is, once the browser has handed it over. */
interface PickedFile {
  readonly type: string;
  readonly size: number;
  readonly name: string;
  readonly body: Blob;
}

function pickFiles(input: HTMLInputElement | null): PickedFile[] {
  const files = input?.files;
  if (files === null || files === undefined) return [];
  return Array.from(files)
    .slice(0, SUPPORT_ATTACHMENTS_PER_MESSAGE)
    .map((file) => ({ type: file.type, size: file.size, name: file.name, body: file }));
}

/**
 * Uploads the chosen files against a message that now exists.
 *
 * Each file is its own three-step exchange, and one failing does not undo the others or the message. What
 * comes back is the number that failed, so a form can say so without naming which server call broke.
 */
async function attachAll(
  ticketId: string,
  messageId: string,
  files: readonly PickedFile[],
): Promise<number> {
  let failed = 0;
  for (const file of files) {
    const result = await runSupportAttachmentUpload(ticketId, messageId, file, {
      origin: (input, init) => fetch(input, init),
      storage: (input, init) => fetch(input, init),
    });
    if (result.kind !== 'ok') failed += 1;
  }
  return failed;
}

/* ------------------------------------------------------------------------------------------------ */
/* Opening a ticket                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

export interface OpenTicketCopy extends SupportFailureLabels {
  readonly action: string;
  readonly heading: string;
  readonly intro: string;
  readonly subjectLabel: string;
  readonly categoryLabel: string;
  readonly categories: Readonly<Record<string, string>>;
  readonly bodyLabel: string;
  readonly filesLabel: string;
  readonly filesHint: string;
  readonly send: string;
  readonly cancel: string;
  readonly working: string;
  readonly subjectRequired: string;
  readonly subjectTooLong: string;
  readonly bodyRequired: string;
  readonly bodyTooLong: string;
  readonly categoryRequired: string;
  readonly filesFailed: string;
  readonly noCredentials: string;
}

export function OpenSupportTicketForm({ copy }: { readonly copy: OpenTicketCopy }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<string>('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [files, setFiles] = useState<HTMLInputElement | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setMessage(null);

    const checkedSubject = prepareText(subject, SUPPORT_SUBJECT_MAX_LENGTH);
    if (!checkedSubject.ok) {
      setMessage(checkedSubject.problem === 'empty' ? copy.subjectRequired : copy.subjectTooLong);
      return;
    }
    const checkedBody = prepareText(body, SUPPORT_BODY_MAX_LENGTH);
    if (!checkedBody.ok) {
      setMessage(checkedBody.problem === 'empty' ? copy.bodyRequired : copy.bodyTooLong);
      return;
    }
    if (!isSupportCategory(category)) {
      setMessage(copy.categoryRequired);
      return;
    }

    const chosen = pickFiles(files);
    setPending(true);
    const result = await openSupportTicket(
      { subject: checkedSubject.value, category, body: checkedBody.value },
      (input, init) => fetch(input, init),
    );

    if (result.kind !== 'ok') {
      setPending(false);
      setMessage(supportFailureMessage(result.kind, copy));
      return;
    }

    const failed = chosen.length === 0 ? 0 : await attachAll(result.ticketId, result.messageId, chosen);
    setPending(false);
    if (failed > 0) {
      // The ticket exists; only the files did not. Saying so is more useful than a generic failure.
      setMessage(copy.filesFailed);
      router.refresh();
      return;
    }

    setOpen(false);
    setSubject('');
    setBody('');
    setCategory('');
    router.refresh();
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            setMessage(null);
            setOpen(true);
          }}
          className={BUTTON_CLASS}
        >
          {copy.action}
        </button>
        {message !== null && (
          <p role="alert" className="mt-2 max-w-prose text-sm font-medium text-neutral-900">
            {message}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="max-w-prose rounded-lg border border-neutral-300 p-4"
      aria-labelledby="open-support-ticket"
    >
      <h2 id="open-support-ticket" className="text-base font-medium text-neutral-900">
        {copy.heading}
      </h2>
      <p className="mt-1 text-sm text-neutral-600">{copy.intro}</p>
      {/* Support content travels to people. The form says plainly what not to put in it. */}
      <p className="mt-2 text-sm font-medium text-neutral-900">{copy.noCredentials}</p>

      <div className="mt-4">
        <label htmlFor="support-subject" className="text-sm font-medium text-neutral-900">
          {copy.subjectLabel}
        </label>
        <input
          id="support-subject"
          name="subject"
          type="text"
          maxLength={SUPPORT_SUBJECT_MAX_LENGTH}
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          className={FIELD_CLASS}
        />
      </div>

      <div className="mt-4">
        <label htmlFor="support-category" className="text-sm font-medium text-neutral-900">
          {copy.categoryLabel}
        </label>
        <select
          id="support-category"
          name="category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className={FIELD_CLASS}
        >
          <option value="">{copy.categoryLabel}</option>
          {SUPPORT_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {copy.categories[value] ?? value}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4">
        <label htmlFor="support-body" className="text-sm font-medium text-neutral-900">
          {copy.bodyLabel}
        </label>
        <textarea
          id="support-body"
          name="body"
          rows={6}
          maxLength={SUPPORT_BODY_MAX_LENGTH}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className={FIELD_CLASS}
        />
      </div>

      <div className="mt-4">
        <label htmlFor="support-files" className="text-sm font-medium text-neutral-900">
          {copy.filesLabel}
        </label>
        <input
          id="support-files"
          name="files"
          type="file"
          multiple
          accept={SUPPORT_ATTACHMENT_ACCEPT}
          ref={setFiles}
          className="mt-1 block w-full text-sm text-neutral-900"
        />
        <p className="mt-1 text-xs text-neutral-600">{copy.filesHint}</p>
      </div>

      {message !== null && (
        <p role="alert" className="mt-4 text-sm font-medium text-neutral-900">
          {message}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <button type="submit" disabled={pending} className={BUTTON_CLASS}>
          {pending ? copy.working : copy.send}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setMessage(null);
          }}
          className={SECONDARY_CLASS}
        >
          {copy.cancel}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Replying                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface ReplyCopy extends SupportFailureLabels {
  readonly label: string;
  readonly placeholder: string;
  readonly filesLabel: string;
  readonly filesHint: string;
  readonly send: string;
  readonly sending: string;
  readonly bodyRequired: string;
  readonly bodyTooLong: string;
  readonly filesFailed: string;
  readonly closedHint: string;
}

export function SupportReplyForm({
  ticketId,
  isClosed,
  copy,
}: {
  readonly ticketId: string;
  readonly isClosed: boolean;
  readonly copy: ReplyCopy;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [files, setFiles] = useState<HTMLInputElement | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || isClosed) return;
    setMessage(null);

    const checked = prepareText(draft, SUPPORT_BODY_MAX_LENGTH);
    if (!checked.ok) {
      setMessage(checked.problem === 'empty' ? copy.bodyRequired : copy.bodyTooLong);
      return;
    }

    const chosen = pickFiles(files);
    setPending(true);
    const result = await postSupportMessage(ticketId, checked.value, (input, init) =>
      fetch(input, init),
    );

    if (result.kind !== 'ok') {
      setPending(false);
      setMessage(supportFailureMessage(result.kind, copy));
      return;
    }

    const failed = chosen.length === 0 ? 0 : await attachAll(ticketId, result.messageId, chosen);
    setPending(false);
    setDraft('');
    setMessage(failed > 0 ? copy.filesFailed : null);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-8 border-t border-neutral-200 pt-6">
      <p aria-live="polite" role="status" className="min-h-6 text-sm text-neutral-900">
        {message ?? (isClosed ? copy.closedHint : null)}
      </p>

      <label htmlFor="support-reply" className="text-sm font-medium text-neutral-900">
        {copy.label}
      </label>
      <textarea
        id="support-reply"
        name="body"
        rows={4}
        maxLength={SUPPORT_BODY_MAX_LENGTH}
        disabled={isClosed || pending}
        placeholder={copy.placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className={FIELD_CLASS}
      />

      {!isClosed && (
        <div className="mt-3">
          <label htmlFor="support-reply-files" className="text-sm font-medium text-neutral-900">
            {copy.filesLabel}
          </label>
          <input
            id="support-reply-files"
            name="files"
            type="file"
            multiple
            accept={SUPPORT_ATTACHMENT_ACCEPT}
            ref={setFiles}
            disabled={pending}
            className="mt-1 block w-full text-sm text-neutral-900"
          />
          <p className="mt-1 text-xs text-neutral-600">{copy.filesHint}</p>
        </div>
      )}

      <div className="mt-4">
        <button type="submit" disabled={isClosed || pending} className={BUTTON_CLASS}>
          {pending ? copy.sending : copy.send}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Ending one's own ticket                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export interface CloseTicketCopy extends SupportFailureLabels {
  readonly action: string;
  readonly question: string;
  readonly warning: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly working: string;
}

/**
 * One button, one meaning.
 *
 * **It sends one identifier and reads a status back.** There is no status field here, because the server takes
 * none: the operation is the whole request. Ending a ticket cannot be undone and nothing on this surface
 * reopens one, so the button opens a confirmation that says so and the second press is the one that sends.
 */
export function CloseSupportTicketForm({
  ticketId,
  copy,
}: {
  readonly ticketId: string;
  readonly copy: CloseTicketCopy;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (pending) return;
    setError(null);
    setPending(true);
    const result = await closeSupportTicket(ticketId, (input, init) => fetch(input, init));
    setPending(false);

    if (result.kind !== 'ok') {
      setError(supportFailureMessage(result.kind, copy));
      return;
    }
    setAsking(false);
    router.refresh();
  }

  if (!asking) {
    return (
      <div className="mt-6">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setAsking(true);
          }}
          className={SECONDARY_CLASS}
        >
          {copy.action}
        </button>
        {error !== null && (
          <p role="alert" className="mt-2 max-w-prose text-sm font-medium text-neutral-900">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-6 max-w-prose rounded-lg border border-neutral-300 p-4">
      <p className="text-sm font-medium text-neutral-900">{copy.question}</p>
      <p className="mt-1 text-sm text-neutral-600">{copy.warning}</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" disabled={pending} onClick={() => void submit()} className={BUTTON_CLASS}>
          {pending ? copy.working : copy.confirm}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setAsking(false);
            setError(null);
          }}
          className={SECONDARY_CLASS}
        >
          {copy.cancel}
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="mt-3 text-sm font-medium text-neutral-900">
          {error}
        </p>
      )}
    </div>
  );
}
