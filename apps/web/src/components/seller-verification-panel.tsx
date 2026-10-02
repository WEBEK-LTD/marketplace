'use client';

import { useRouter } from 'next/navigation';
import { useState, type ChangeEvent } from 'react';
import type { SellerVerificationDocumentType } from '@repo/contracts';
import {
  DOCUMENT_ACCEPT,
  DOCUMENT_TYPES,
  checkChosenDocument,
  removeDocument,
  runDocumentUpload,
  startVerification,
  submitVerification,
  type VerificationOutcome,
} from './seller-verification';

/**
 * The seller's own verification, and whatever their current state lets them do with it (Phase 6-I).
 *
 * **What crosses the server/client boundary.** Copy, one {@link RenderableVerification} — a narrowed render
 * type projected field by field on the server — and one label group per action this attempt actually offers.
 * No verification id, no seller id, no account, no token, no object path, no reviewer, no review time, no
 * decision reason and no document review note: not one of those is in the projection, so not one can be in
 * the RSC payload.
 *
 * **Which controls exist is decided on the server, and the copy proves it.** The page passes `start`,
 * `documents` and `submit` label groups, and a null group means that action is not offered — so a control
 * this state does not allow has no text to render with, and its copy is not even in the payload. A verified
 * storefront therefore receives no start group and no submit group, which is owner decision 2 expressed as
 * an absence rather than as a hidden element. The client checks the same question again through
 * `verificationActions`, which is the one place that rule is written. This component takes no permission
 * flags of its own precisely so there is only one answer: a label group is the permission, and a control
 * that has no copy cannot be rendered at all. `app_private` refuses every one of these a second time anyway.
 * Controls that are not permitted are **absent**, never disabled: a disabled button is still in the DOM to
 * re-enable.
 *
 * **No optimistic write.** Every success refreshes the route, so the state this panel then shows was read
 * back from the database rather than assumed from a click. A failure leaves it exactly as the server last
 * described it.
 *
 * **The signed upload URL never reaches this component.** It lives inside one function call in
 * `runDocumentUpload`; nothing here holds it, renders it or puts it in an attribute.
 */

/** One document, as the server chose to describe it. Seven fields, and no path among them. */
export interface RenderableDocument {
  readonly id: string;
  readonly documentType: string;
  readonly originalFilename: string;
  readonly status: string;
  readonly typeLabel: string;
  readonly statusLabel: string;
}

/** The attempt, as the server chose to describe it. */
export interface RenderableVerification {
  readonly status: string;
  readonly statusLabel: string;
  readonly emailVerified: boolean;
  readonly phoneVerified: boolean;
  readonly documents: readonly RenderableDocument[];
}

/** Always present: what the panel displays, and what a refusal says. */
export interface VerificationPanelLabels {
  readonly statusLabel: string;
  readonly contact: string;
  readonly emailVerified: string;
  readonly phoneVerified: string;
  readonly contactYes: string;
  readonly contactNo: string;
  readonly contactHint: string;
  readonly documents: string;
  readonly noDocuments: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly errorExists: string;
  readonly errorAlreadyVerified: string;
  readonly errorNotEditable: string;
  readonly errorPathTaken: string;
  readonly errorMissingObject: string;
  readonly errorInvalid: string;
  readonly errorNotFound: string;
  readonly errorUnavailable: string;
}

/** Present only when an attempt may be started. */
export interface VerificationStartLabels {
  readonly noAttempt: string;
  readonly start: string;
  readonly starting: string;
}

/** Present only when documents may be added or removed. */
export interface VerificationDocumentLabels {
  readonly documentType: string;
  readonly chooseFile: string;
  readonly add: string;
  readonly adding: string;
  readonly added: string;
  readonly allowedTypes: string;
  readonly noFile: string;
  readonly typeNotAllowed: string;
  readonly tooLarge: string;
  readonly remove: string;
  readonly removing: string;
  readonly removed: string;
  readonly removeConfirm: string;
  readonly typeLabels: Readonly<Record<string, string>>;
}

/** Present only when the attempt may be submitted. */
export interface VerificationSubmitLabels {
  readonly submit: string;
  readonly submitting: string;
  readonly submitted: string;
  readonly submitConfirm: string;
  readonly submitHint: string;
}

export interface SellerVerificationPanelProps {
  readonly verification: RenderableVerification | null;
  readonly labels: VerificationPanelLabels;
  readonly start: VerificationStartLabels | null;
  readonly documents: VerificationDocumentLabels | null;
  readonly submit: VerificationSubmitLabels | null;
}

const BUTTON =
  'inline-flex items-center justify-center rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:opacity-60';
const QUIET =
  'inline-flex items-center justify-center rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-800 hover:border-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:opacity-60';

export function SellerVerificationPanel({
  verification,
  labels,
  start,
  documents,
  submit,
}: SellerVerificationPanelProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState<SellerVerificationDocumentType>(
    DOCUMENT_TYPES[0],
  );
  const [file, setFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  /** Every refusal becomes a sentence about this account. None becomes one about a reviewer. */
  function say(outcome: VerificationOutcome): boolean {
    switch (outcome.kind) {
      case 'ok':
      case 'state':
        return true;
      case 'exists':
        setError(labels.errorExists);
        return false;
      case 'already_verified':
        setError(labels.errorAlreadyVerified);
        return false;
      case 'not_editable':
        setError(labels.errorNotEditable);
        return false;
      case 'path_taken':
        setError(labels.errorPathTaken);
        return false;
      case 'missing_object':
        setError(labels.errorMissingObject);
        return false;
      case 'invalid':
        setError(labels.errorInvalid);
        return false;
      case 'not_found':
        setError(labels.errorNotFound);
        return false;
      default:
        setError(labels.errorUnavailable);
        return false;
    }
  }

  async function run(key: string, work: () => Promise<VerificationOutcome>, done: string) {
    setBusy(key);
    setError(null);
    setMessage(null);
    const outcome = await work();
    setBusy(null);
    setConfirming(null);
    if (say(outcome)) {
      setMessage(done);
      setFile(null);
      // Read back rather than assume: the panel's next render comes from the database.
      router.refresh();
    }
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setError(null);
    setMessage(null);
  }

  async function addDocument() {
    if (documents === null) return;
    const checked = checkChosenDocument(file === null ? null : { type: file.type, size: file.size });
    if (!checked.ok) {
      setMessage(null);
      setError(
        checked.reason === 'missing'
          ? documents.noFile
          : checked.reason === 'type'
            ? documents.typeNotAllowed
            : documents.tooLarge,
      );
      return;
    }
    const chosen = file as File;
    await run(
      'add',
      () =>
        runDocumentUpload(documentType, {
          type: chosen.type,
          size: chosen.size,
          body: chosen,
          name: chosen.name,
        }),
      documents.added,
    );
  }

  return (
    <section className="mt-6 rounded-lg border border-neutral-200 p-4">
      {verification === null ? (
        // No attempt. Either there is a start control, or — for a verified storefront — there is not, and
        // the page has already said so above this panel.
        start === null ? null : (
          <>
            <p className="text-sm text-neutral-700">{start.noAttempt}</p>
            <button
              type="button"
              className={`${BUTTON} mt-3`}
              disabled={busy !== null}
              onClick={() => void run('start', () => startVerification(), start.start)}
            >
              {busy === 'start' ? start.starting : start.start}
            </button>
          </>
        )
      ) : (
        <>
          <p className="text-sm">
            <span className="text-neutral-500">{labels.statusLabel}: </span>
            <span className="font-medium">{verification.statusLabel}</span>
          </p>

          <h3 className="mt-4 text-sm font-medium">{labels.contact}</h3>
          <ul className="mt-1 text-sm text-neutral-700">
            <li>
              {labels.emailVerified}:{' '}
              {verification.emailVerified ? labels.contactYes : labels.contactNo}
            </li>
            <li>
              {labels.phoneVerified}:{' '}
              {verification.phoneVerified ? labels.contactYes : labels.contactNo}
            </li>
          </ul>
          <p className="mt-1 text-xs text-neutral-500">{labels.contactHint}</p>

          <h3 className="mt-4 text-sm font-medium">{labels.documents}</h3>
          {verification.documents.length === 0 ? (
            <p className="mt-1 text-sm text-neutral-700">{labels.noDocuments}</p>
          ) : (
            <ul className="mt-1 divide-y divide-neutral-100">
              {verification.documents.map((document) => (
                <li
                  key={document.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                >
                  <span className="text-sm">
                    <span className="font-medium">{document.typeLabel}</span>{' '}
                    <span className="text-neutral-600">{document.originalFilename}</span>{' '}
                    <span className="text-neutral-500">— {document.statusLabel}</span>
                  </span>
                  {documents === null ? null : confirming === document.id ? (
                    <span className="flex items-center gap-2">
                      <span className="text-sm text-neutral-700">{documents.removeConfirm}</span>
                      <button
                        type="button"
                        className={QUIET}
                        disabled={busy !== null}
                        onClick={() =>
                          void run(
                            `remove:${document.id}`,
                            () => removeDocument(document.id),
                            documents.removed,
                          )
                        }
                      >
                        {busy === `remove:${document.id}` ? documents.removing : labels.confirm}
                      </button>
                      <button type="button" className={QUIET} onClick={() => setConfirming(null)}>
                        {labels.cancel}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={QUIET}
                      disabled={busy !== null}
                      onClick={() => setConfirming(document.id)}
                    >
                      {documents.remove}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {documents === null ? null : (
            <div className="mt-4 border-t border-neutral-100 pt-4">
              <label className="block text-sm" htmlFor="verification-document-type">
                {documents.documentType}
              </label>
              <select
                id="verification-document-type"
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                value={documentType}
                onChange={(event) =>
                  setDocumentType(event.target.value as SellerVerificationDocumentType)
                }
              >
                {DOCUMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {documents.typeLabels[type] ?? type}
                  </option>
                ))}
              </select>

              <label className="mt-3 block text-sm" htmlFor="verification-document-file">
                {documents.chooseFile}
              </label>
              <input
                id="verification-document-file"
                type="file"
                accept={DOCUMENT_ACCEPT}
                className="mt-1 block w-full text-sm"
                onChange={chooseFile}
              />
              <p className="mt-1 text-xs text-neutral-500">{documents.allowedTypes}</p>

              <button
                type="button"
                className={`${BUTTON} mt-3`}
                disabled={busy !== null}
                onClick={() => void addDocument()}
              >
                {busy === 'add' ? documents.adding : documents.add}
              </button>
            </div>
          )}

          {submit === null ? null : (
            <div className="mt-4 border-t border-neutral-100 pt-4">
              <p className="text-xs text-neutral-500">{submit.submitHint}</p>
              {confirming === 'submit' ? (
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm text-neutral-700">{submit.submitConfirm}</span>
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={busy !== null}
                    onClick={() =>
                      void run('submit', () => submitVerification(), submit.submitted)
                    }
                  >
                    {busy === 'submit' ? submit.submitting : labels.confirm}
                  </button>
                  <button type="button" className={QUIET} onClick={() => setConfirming(null)}>
                    {labels.cancel}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={`${BUTTON} mt-2`}
                  disabled={busy !== null}
                  onClick={() => setConfirming('submit')}
                >
                  {submit.submit}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {message === null ? null : (
        <p role="status" className="mt-3 text-sm text-neutral-700">
          {message}
        </p>
      )}
    </section>
  );
}
