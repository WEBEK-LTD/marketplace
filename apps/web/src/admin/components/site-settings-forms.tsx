'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { SiteSetting } from '@repo/contracts';
import { adminApiPath } from '../paths';

/**
 * The part of a setting this control actually needs.
 *
 * **Narrower than `SiteSetting` on purpose.** This is a client component, so every field of every prop is
 * serialised into the flight payload and sent to the browser. A `SiteSetting` carries `descriptionEn` *and*
 * `descriptionAr`, and the screen has already chosen between them — so passing the whole row would ship the
 * other language's copy of every setting to every reader, which a test caught by finding English in the
 * Arabic console. It would also send `updatedAt`, which nothing here renders.
 */
export type EditableSetting = Pick<SiteSetting, 'key' | 'category' | 'value' | 'valueType' | 'isPublic'>;

/**
 * The site-settings controls (0113).
 *
 * **One form per setting, and each saves on its own.** A settings screen that saved everything at once would
 * make one bad value lose every other edit on the page, and it would have to decide what "unchanged" means for
 * a field somebody never touched. A setting is one value; saving it is one request.
 *
 * **The control follows the setting's declared type**, which the API reports. A string gets a text field, a
 * number a numeric one, a boolean a checkbox, and a `json` setting a textarea holding its text. That is why the
 * type is in the response at all: the console renders what the database declared rather than what somebody
 * assumed, and a setting whose type changes in a migration changes shape here with no edit.
 *
 * **Nothing is coerced.** A `json` field that does not parse is refused here, before a request, with the
 * parser's own complaint — the one case where showing the underlying message is more useful than replacing it,
 * because it names the character that is wrong. Everything else is refused by the database, and this screen
 * reports that refusal rather than guessing at a value the operator might have meant.
 *
 * **No optimistic state.** A value that failed to save is still in the box, which matters for a setting
 * somebody composed once — an address, a line of opening hours.
 *
 * **`isPublic` is shown and is not editable.** An operator typing into a field should know whether what they
 * type will appear on the public site; changing that is a migration decision, because it changes what the
 * public reader is allowed to serve.
 */

const BUTTON_CLASS = 'rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink disabled:opacity-60';
const FIELD_CLASS = 'mt-1 w-full rounded-md border border-edge px-3 py-2 text-sm text-ink-strong';
const MONO_FIELD_CLASS = 'mt-1 w-full rounded-md border border-edge px-3 py-2 font-mono text-xs text-ink-strong';
const LABEL_CLASS = 'block text-sm font-medium text-ink-body';
const HINT_CLASS = 'mt-1 text-xs text-ink-muted';

/** The copy one setting's form needs. */
export interface SiteSettingFormCopy {
  readonly save: string;
  readonly saving: string;
  readonly saved: string;
  readonly publicBadge: string;
  readonly privateBadge: string;
  readonly booleanOn: string;
  readonly invalidJson: string;
  readonly refused: string;
  readonly notFound: string;
  readonly sessionExpired: string;
  readonly unavailable: string;
}

interface Outcome {
  readonly status: number | null;
  readonly code: string | null;
}

async function send(body: Record<string, unknown>): Promise<Outcome> {
  try {
    const response = await fetch(adminApiPath('/api/settings'), {
      method: 'PUT',
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

function Problem({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p className="mt-3 rounded-md border border-edge bg-surface-muted p-3 text-sm text-ink-strong" role="alert">
      {message}
    </p>
  );
}

/** The stored value as the text a field starts with. */
function initialText(setting: EditableSetting): string {
  if (setting.valueType === 'json') return JSON.stringify(setting.value ?? null, null, 2);
  if (setting.valueType === 'number') return typeof setting.value === 'number' ? String(setting.value) : '';
  return typeof setting.value === 'string' ? setting.value : '';
}

export function SiteSettingForm({
  setting,
  label,
  description,
  copy,
}: {
  readonly setting: EditableSetting;
  readonly label: string;
  readonly description: string;
  readonly copy: SiteSettingFormCopy;
}) {
  const router = useRouter();
  const [text, setText] = useState(() => initialText(setting));
  const [checked, setChecked] = useState(setting.value === true);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A multi-line value — an address, a crawl policy, a JSON document — gets a textarea. The address settings
  // are the reason: an operator writes one over three lines and a single-line field would flatten it.
  const multiline = setting.valueType === 'json' || setting.key.includes('address');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setDone(false);
    setProblem(null);

    let value: unknown;
    if (setting.valueType === 'boolean') {
      value = checked;
    } else if (setting.valueType === 'number') {
      const parsed = Number(text.trim());
      if (text.trim() === '' || !Number.isFinite(parsed)) {
        setPending(false);
        setProblem(copy.refused);
        return;
      }
      value = parsed;
    } else if (setting.valueType === 'json') {
      try {
        value = JSON.parse(text.trim() === '' ? 'null' : text);
      } catch (error) {
        setPending(false);
        // The parser's own complaint, which is the one message more useful than ours: it names the character.
        setProblem(`${copy.invalidJson} ${error instanceof Error ? error.message : ''}`.trim());
        return;
      }
    } else {
      value = text;
    }

    const outcome = await send({ category: setting.category, key: setting.key, value });
    setPending(false);

    if (outcome.status === 200) {
      setDone(true);
      router.refresh();
      return;
    }
    if (outcome.status === 401) setProblem(copy.sessionExpired);
    else if (outcome.status === 404) setProblem(copy.notFound);
    else if (outcome.status === 409) setProblem(copy.refused);
    else setProblem(copy.unavailable);
  }

  return (
    <form onSubmit={submit} className="border-t border-hairline py-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label className={LABEL_CLASS} htmlFor={setting.key}>
          {label}
        </label>
        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-ink-muted">
          {setting.isPublic ? copy.publicBadge : copy.privateBadge}
        </span>
      </div>

      {setting.valueType === 'boolean' ? (
        <label className="mt-2 flex items-center gap-2 text-sm text-ink-strong">
          <input
            id={setting.key}
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          {copy.booleanOn}
        </label>
      ) : multiline ? (
        <textarea
          id={setting.key}
          rows={setting.valueType === 'json' ? 6 : 3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          className={setting.valueType === 'json' ? MONO_FIELD_CLASS : FIELD_CLASS}
          /* The value may be in either script whatever language the console is in. */
          dir="auto"
        />
      ) : (
        <input
          id={setting.key}
          type={setting.valueType === 'number' ? 'number' : 'text'}
          value={text}
          onChange={(event) => setText(event.target.value)}
          className={FIELD_CLASS}
          dir="auto"
        />
      )}

      <p className={HINT_CLASS}>{description}</p>

      <div className="mt-3 flex items-center gap-3">
        <button type="submit" className={BUTTON_CLASS} disabled={pending}>
          {pending ? copy.saving : copy.save}
        </button>
        {done ? <span className="text-sm text-ink-muted">{copy.saved}</span> : null}
      </div>
      <Problem message={problem} />
    </form>
  );
}
