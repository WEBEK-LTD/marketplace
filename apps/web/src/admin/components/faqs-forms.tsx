'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FAQ_QUESTION_MAX, FAQ_TOPIC_MAX } from '@repo/contracts';
import { adminApiPath, adminPath } from '../paths';

/**
 * The help-centre controls (0095).
 *
 * What these forms deliberately do **not** contain:
 *
 * - **No publication control on an editing form.** Publishing an entry is its own button, so correcting a typo
 *   cannot put an answer on a public page (owner decision 6).
 * - **No markup toolbar, and no markup field.** An answer is plain text and is rendered as paragraphs split on
 *   blank lines (owner decision 3), so a rich-text control here would promise something nothing renders.
 * - **No image field.** `faqs` has no media column and this platform has no media origin.
 * - **No structured-data or SEO field** (owner decision 4).
 * - **No closed topic list.** The topic is typed, with the topics already in use offered as suggestions, because
 *   topics are free-form by owner decision 5 — and the screen says which ones no public address shows.
 * - **No optimistic state.** Typed text survives a failed request.
 */

const BUTTON_CLASS = 'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong disabled:opacity-60';
const DANGER_CLASS =
  'rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-60';
const FIELD_CLASS = 'mt-1 w-full rounded-md border border-edge px-3 py-2 text-sm text-ink-strong';
const LABEL_CLASS = 'block text-sm font-medium text-ink-body';
const HINT_CLASS = 'mt-1 text-xs text-ink-muted';

interface Outcome {
  readonly status: number | null;
  readonly code: string | null;
}

async function send(
  path: string,
  body: Record<string, unknown>,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<Outcome> {
  try {
    const response = await fetch(adminApiPath(path), {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let code: string | null = null;
    try {
      const payload = JSON.parse(await response.text()) as { code?: unknown };
      if (typeof payload.code === 'string') code = payload.code;
    } catch {
      code = null;
    }
    return { status: response.status, code };
  } catch {
    return { status: null, code: null };
  }
}

/** One sentence for one outcome. A code the screen knows gets its own; everything else is the generic one. */
function messageFor(
  outcome: Outcome,
  copy: { readonly failed: string; readonly invalid: string } & Partial<{ readonly notAllowed: string }>,
): string {
  if (outcome.code === 'FAQ_NOT_ALLOWED' && copy.notAllowed !== undefined) return copy.notAllowed;
  if (outcome.status === 400) return copy.invalid;
  return copy.failed;
}

function Problem({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {message}
    </p>
  );
}

/** The copy every entry form needs. One shape, used by the create form and by one entry's own controls. */
export interface FaqEntryCopy {
  readonly topicLabel: string;
  readonly topicHint: string;
  readonly questionEnLabel: string;
  readonly questionArLabel: string;
  readonly answerEnLabel: string;
  readonly answerArLabel: string;
  readonly answerHint: string;
  readonly sortOrderLabel: string;
  readonly submit: string;
  readonly failed: string;
  readonly invalid: string;
  readonly notAllowed: string;
}

/* ------------------------------------------------------------------------------------------------ */
/* Creating an entry                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

export interface FaqCreateCopy extends FaqEntryCopy {
  readonly unpublishedNotice: string;
}

export function FaqCreateForm({
  topics,
  copy,
}: {
  /** The topics already in use, offered as suggestions. Typing a new one is the point of a free-form topic. */
  readonly topics: readonly string[];
  readonly copy: FaqCreateCopy;
}) {
  const router = useRouter();
  const [values, setValues] = useState({
    topic: topics[0] ?? 'faq',
    questionEn: '',
    questionAr: '',
    answerEn: '',
    answerAr: '',
    sortOrder: '',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function set(field: keyof typeof values, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const outcome = await send('/api/faqs', {
      topic: values.topic.trim(),
      questionEn: values.questionEn.trim(),
      ...(values.questionAr.trim() === '' ? {} : { questionAr: values.questionAr.trim() }),
      answerEn: values.answerEn.trim(),
      ...(values.answerAr.trim() === '' ? {} : { answerAr: values.answerAr.trim() }),
      ...(values.sortOrder.trim() === '' ? {} : { sortOrder: Number(values.sortOrder) }),
    });
    setBusy(false);
    if (outcome.status === 201) {
      setValues({ ...values, questionEn: '', questionAr: '', answerEn: '', answerAr: '', sortOrder: '' });
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <label className={LABEL_CLASS}>
        {copy.topicLabel}
        <input
          className={FIELD_CLASS}
          list="faq-topics"
          maxLength={FAQ_TOPIC_MAX}
          name="topic"
          onChange={(event) => set('topic', event.target.value)}
          required
          value={values.topic}
        />
        <datalist id="faq-topics">
          {topics.map((topic) => (
            <option key={topic} value={topic} />
          ))}
        </datalist>
        <span className={HINT_CLASS}>{copy.topicHint}</span>
      </label>

      <label className={LABEL_CLASS}>
        {copy.sortOrderLabel}
        <input
          className={FIELD_CLASS}
          inputMode="numeric"
          name="sortOrder"
          onChange={(event) => set('sortOrder', event.target.value)}
          value={values.sortOrder}
        />
      </label>

      <label className={LABEL_CLASS}>
        {copy.questionEnLabel}
        <input
          className={FIELD_CLASS}
          maxLength={FAQ_QUESTION_MAX}
          name="questionEn"
          onChange={(event) => set('questionEn', event.target.value)}
          required
          value={values.questionEn}
        />
      </label>

      <label className={LABEL_CLASS}>
        {copy.questionArLabel}
        <input
          className={FIELD_CLASS}
          dir="rtl"
          lang="ar"
          maxLength={FAQ_QUESTION_MAX}
          name="questionAr"
          onChange={(event) => set('questionAr', event.target.value)}
          value={values.questionAr}
        />
      </label>

      <label className={`${LABEL_CLASS} sm:col-span-2`}>
        {copy.answerEnLabel}
        <textarea
          className={FIELD_CLASS}
          name="answerEn"
          onChange={(event) => set('answerEn', event.target.value)}
          required
          rows={5}
          value={values.answerEn}
        />
        <span className={HINT_CLASS}>{copy.answerHint}</span>
      </label>

      <label className={`${LABEL_CLASS} sm:col-span-2`}>
        {copy.answerArLabel}
        <textarea
          className={FIELD_CLASS}
          dir="rtl"
          lang="ar"
          name="answerAr"
          onChange={(event) => set('answerAr', event.target.value)}
          rows={5}
          value={values.answerAr}
        />
      </label>

      <div className="sm:col-span-2">
        <p className="text-sm text-ink-muted">{copy.unpublishedNotice}</p>
        <button className={`${BUTTON_CLASS} mt-3`} disabled={busy} type="submit">
          {copy.submit}
        </button>
        <Problem message={message} />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One entry's own controls                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface FaqControlsCopy extends FaqEntryCopy {
  readonly clearArabic: string;
  readonly toggle: string;
  readonly remove: string;
  readonly removeConfirm: string;
}

export function FaqControls({
  faqId,
  isPublished,
  topic,
  questionEn,
  questionAr,
  answerEn,
  answerAr,
  sortOrder,
  topics,
  copy,
}: {
  readonly faqId: string;
  readonly isPublished: boolean;
  readonly topic: string;
  readonly questionEn: string;
  readonly questionAr: string | null;
  readonly answerEn: string;
  readonly answerAr: string | null;
  readonly sortOrder: number;
  readonly topics: readonly string[];
  readonly copy: FaqControlsCopy;
}) {
  const router = useRouter();
  const [values, setValues] = useState({
    topic,
    questionEn,
    questionAr: questionAr ?? '',
    answerEn,
    answerAr: answerAr ?? '',
    sortOrder: String(sortOrder),
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function set(field: keyof typeof values, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  async function run(action: () => Promise<Outcome>, after: 'refresh' | 'list' = 'refresh'): Promise<void> {
    setBusy(true);
    setMessage(null);
    const outcome = await action();
    setBusy(false);
    if (outcome.status === 200) {
      if (after === 'list') router.push(adminPath('/cms/faqs'));
      else router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await run(async () =>
      send(
        '/api/faqs',
        {
          faqId,
          topic: values.topic.trim(),
          questionEn: values.questionEn.trim(),
          // Sent as null to clear it, which is a different thing from leaving it out.
          questionAr: values.questionAr.trim() === '' ? null : values.questionAr.trim(),
          answerEn: values.answerEn.trim(),
          answerAr: values.answerAr.trim() === '' ? null : values.answerAr.trim(),
          ...(values.sortOrder.trim() === '' ? {} : { sortOrder: Number(values.sortOrder) }),
        },
        'PATCH',
      ),
    );
  }

  async function remove(): Promise<void> {
    if (!window.confirm(copy.removeConfirm)) return;
    await run(async () => send('/api/faqs/remove', { faqId }), 'list');
  }

  return (
    <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={save}>
      <label className={LABEL_CLASS}>
        {copy.topicLabel}
        <input
          className={FIELD_CLASS}
          list="faq-topics-edit"
          maxLength={FAQ_TOPIC_MAX}
          name="topic"
          onChange={(event) => set('topic', event.target.value)}
          required
          value={values.topic}
        />
        <datalist id="faq-topics-edit">
          {topics.map((entry) => (
            <option key={entry} value={entry} />
          ))}
        </datalist>
        <span className={HINT_CLASS}>{copy.topicHint}</span>
      </label>

      <label className={LABEL_CLASS}>
        {copy.sortOrderLabel}
        <input
          className={FIELD_CLASS}
          inputMode="numeric"
          name="sortOrder"
          onChange={(event) => set('sortOrder', event.target.value)}
          value={values.sortOrder}
        />
      </label>

      <label className={LABEL_CLASS}>
        {copy.questionEnLabel}
        <input
          className={FIELD_CLASS}
          maxLength={FAQ_QUESTION_MAX}
          name="questionEn"
          onChange={(event) => set('questionEn', event.target.value)}
          required
          value={values.questionEn}
        />
      </label>

      <label className={LABEL_CLASS}>
        {copy.questionArLabel}
        <input
          className={FIELD_CLASS}
          dir="rtl"
          lang="ar"
          maxLength={FAQ_QUESTION_MAX}
          name="questionAr"
          onChange={(event) => set('questionAr', event.target.value)}
          value={values.questionAr}
        />
        <span className={HINT_CLASS}>{copy.clearArabic}</span>
      </label>

      <label className={`${LABEL_CLASS} sm:col-span-2`}>
        {copy.answerEnLabel}
        <textarea
          className={FIELD_CLASS}
          name="answerEn"
          onChange={(event) => set('answerEn', event.target.value)}
          required
          rows={6}
          value={values.answerEn}
        />
        <span className={HINT_CLASS}>{copy.answerHint}</span>
      </label>

      <label className={`${LABEL_CLASS} sm:col-span-2`}>
        {copy.answerArLabel}
        <textarea
          className={FIELD_CLASS}
          dir="rtl"
          lang="ar"
          name="answerAr"
          onChange={(event) => set('answerAr', event.target.value)}
          rows={6}
          value={values.answerAr}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button className={BUTTON_CLASS} disabled={busy} type="submit">
          {copy.submit}
        </button>
        <button
          className={SECONDARY_CLASS}
          disabled={busy}
          onClick={() => void run(async () => send('/api/faqs/state', { faqId, isPublished: !isPublished }))}
          type="button"
        >
          {copy.toggle}
        </button>
        <button className={DANGER_CLASS} disabled={busy} onClick={remove} type="button">
          {copy.remove}
        </button>
      </div>
      <div className="sm:col-span-2">
        <Problem message={message} />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Reordering one topic                                                                              */
/* ------------------------------------------------------------------------------------------------ */

export interface FaqReorderCopy {
  readonly heading: string;
  readonly hint: string;
  readonly up: string;
  readonly down: string;
  readonly submit: string;
  readonly failed: string;
  readonly invalid: string;
}

export function FaqReorderForm({
  topic,
  entries,
  copy,
}: {
  readonly topic: string;
  readonly entries: readonly { readonly id: string; readonly label: string }[];
  readonly copy: FaqReorderCopy;
}) {
  const router = useRouter();
  const [order, setOrder] = useState<readonly { id: string; label: string }[]>(
    entries.map((entry) => ({ id: entry.id, label: entry.label })),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function move(index: number, by: -1 | 1): void {
    const next = [...order];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    const moved = next[index];
    const displaced = next[target];
    if (moved === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = moved;
    setOrder(next);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setMessage(null);
    const outcome = await send('/api/faqs/reorder', { topic, faqIds: order.map((entry) => entry.id) });
    setBusy(false);
    if (outcome.status === 200) {
      router.refresh();
      return;
    }
    setMessage(messageFor(outcome, copy));
  }

  return (
    <div className="mt-6">
      <p className="text-sm font-medium text-ink-body">{copy.heading}</p>
      <p className={HINT_CLASS}>{copy.hint}</p>
      <ol className="mt-3 space-y-2">
        {order.map((entry, index) => (
          <li className="flex items-center gap-3 text-sm text-ink-strong" key={entry.id}>
            <span className="flex-1">{entry.label}</span>
            <button
              aria-label={`${copy.up}: ${entry.label}`}
              className={SECONDARY_CLASS}
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
              type="button"
            >
              {copy.up}
            </button>
            <button
              aria-label={`${copy.down}: ${entry.label}`}
              className={SECONDARY_CLASS}
              disabled={busy || index === order.length - 1}
              onClick={() => move(index, 1)}
              type="button"
            >
              {copy.down}
            </button>
          </li>
        ))}
      </ol>
      <button className={`${BUTTON_CLASS} mt-3`} disabled={busy} onClick={submit} type="button">
        {copy.submit}
      </button>
      <Problem message={message} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */

export function FaqBackLink({ label }: { readonly label: string }) {
  return (
    <Link className="text-ink-strong underline" href={adminPath('/cms/faqs')}>
      {label}
    </Link>
  );
}
