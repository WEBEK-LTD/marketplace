'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  LISTING_ATTRIBUTE_NUMBER_ABS_MAX,
  LISTING_ATTRIBUTE_TEXT_MAX,
  type AttributeDataType,
  type SaveSellerListingAttributesRequest,
} from '@repo/contracts';

/**
 * The attributes a seller is asked about one of their own listings, and the tags they may put on it (Phase 8-C).
 *
 * **Each field is rendered from its attribute's own data type**, because that is what the database validated
 * every stored answer against: a number gets a number field with its unit beside it, a yes-or-no gets a
 * checkbox, one-from-a-list gets a radio group with a "no answer" choice, and several-from-a-list gets
 * checkboxes. A text field would accept all of those and then be refused, which is a worse way to learn.
 *
 * **A required attribute is marked, and submission is not blocked.** `is_required` is advisory in this release:
 * the field carries the word "required", the form says in a sentence that an unanswered one will not stop a
 * listing being submitted, and nothing here refuses a save for want of an answer. That is the whole of what the
 * flag does, and saying so is better than letting a seller discover it later either way.
 *
 * **Clearing an answer is leaving it blank.** The save replaces the whole set, so an empty field is sent as no
 * answer at all rather than as an empty one — which is also the only thing the database would accept, since a
 * stored answer must carry exactly one value.
 *
 * **No optimistic state.** A failed save leaves every typed answer where it is; a successful one refreshes the
 * route, so what the form then shows was read back rather than assumed.
 *
 * **Two saves, not one.** The attributes and the tags are separate operations in the API because they are
 * separate rules in the database, and a single button would have to decide what to do when one half succeeded.
 */

const BUTTON_CLASS =
  'rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-neutral-0 disabled:opacity-60';
const FIELD_CLASS = 'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900';
const LABEL_CLASS = 'block text-sm font-medium text-neutral-900';
const HINT_CLASS = 'mt-1 max-w-prose text-sm text-neutral-600';

/** One question, projected field by field on the server. No identifier reaches a browser. */
export interface RenderableAttribute {
  readonly key: string;
  readonly label: string;
  readonly dataType: AttributeDataType;
  readonly unit: string | null;
  readonly isRequired: boolean;
  readonly text: string | null;
  readonly number: number | null;
  readonly boolean: boolean | null;
  readonly options: readonly string[];
  readonly choices: readonly { readonly value: string; readonly label: string }[];
}

export interface RenderableTag {
  readonly slug: string;
  readonly name: string;
  readonly isSelected: boolean;
}

/** Always present: what the page displays, whether or not anything may be changed. */
export interface SellerVocabularyLabels {
  readonly attributesHeading: string;
  readonly attributesIntro: string;
  readonly required: string;
  readonly advisory: string;
  readonly noAnswer: string;
  readonly yes: string;
  readonly no: string;
  /** How a list of answers reads in this language, because a comma is not the same character in both. */
  readonly listSeparator: string;
  readonly tagsHeading: string;
  readonly tagsIntro: string;
  readonly noQuestions: string;
  readonly noTags: string;
  readonly notEditable: string;
}

/**
 * Present only when this listing's answers may be changed.
 *
 * A separate group, and a null one means no form at all — the same convention 6-F's rows use, and for the same
 * reason: a control that is not permitted has no text to render with, so its copy is not even in the payload.
 */
export interface SellerVocabularyEditLabels {
  readonly save: string;
  readonly saving: string;
  readonly saved: string;
  readonly saveTags: string;
  readonly tagsSaved: string;
  readonly errorRefused: string;
  readonly errorNotEditable: string;
  readonly errorInvalid: string;
  readonly errorUnavailable: string;
}

interface Outcome {
  readonly status: number | null;
  readonly code: string | null;
}

async function send(path: string, body: unknown): Promise<Outcome> {
  try {
    const response = await fetch(path, {
      method: 'POST',
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

/** One sentence for one outcome. Each refusal a seller can act on gets its own. */
function messageFor(outcome: Outcome, labels: SellerVocabularyEditLabels, success: string): string {
  if (outcome.status === 200) return success;
  if (outcome.code === 'LISTING_ATTRIBUTE_ANSWER_NOT_ALLOWED') return labels.errorRefused;
  if (outcome.code === 'SELLER_LISTING_NOT_EDITABLE') return labels.errorNotEditable;
  if (outcome.code === 'VALIDATION_FAILED') return labels.errorInvalid;
  return labels.errorUnavailable;
}

/** What the form holds for one attribute while it is being edited. */
type Draft = { readonly text: string; readonly boolean: boolean; readonly options: readonly string[] };

function initialDraft(attribute: RenderableAttribute): Draft {
  return {
    text:
      attribute.dataType === 'number'
        ? attribute.number === null
          ? ''
          : String(attribute.number)
        : (attribute.text ?? ''),
    boolean: attribute.boolean ?? false,
    options: [...attribute.options],
  };
}

/**
 * One answer, in the shape its attribute's kind takes — or nothing at all.
 *
 * An attribute left blank is **left out** of the request rather than sent empty, which is how a seller clears
 * one. A boolean is the exception that proves the rule: false is an answer, so it is always sent.
 */
function answerOf(
  attribute: RenderableAttribute,
  draft: Draft,
): SaveSellerListingAttributesRequest['answers'][number] | null {
  if (attribute.dataType === 'text') {
    const text = draft.text.trim();
    return text === '' ? null : { kind: 'text', key: attribute.key, text };
  }
  if (attribute.dataType === 'number') {
    const text = draft.text.trim();
    if (text === '') return null;
    const value = Number(text);
    return Number.isFinite(value) ? { kind: 'number', key: attribute.key, number: value } : null;
  }
  if (attribute.dataType === 'boolean') {
    return { kind: 'boolean', key: attribute.key, boolean: draft.boolean };
  }
  if (attribute.dataType === 'single_select') {
    const [chosen] = draft.options;
    return chosen === undefined ? null : { kind: 'single_select', key: attribute.key, options: [chosen] };
  }
  return draft.options.length === 0
    ? null
    : { kind: 'multi_select', key: attribute.key, options: [...draft.options] };
}

export function SellerVocabularyForm({
  path,
  attributes,
  tags,
  labels,
  editing: editLabels,
}: {
  /** The seller's own address for this listing, under `/api/sellers/me/...`. */
  readonly path: string;
  readonly attributes: readonly RenderableAttribute[];
  readonly tags: readonly RenderableTag[];
  readonly labels: SellerVocabularyLabels;
  /** Null when the listing is no longer a draft: then there is no form, and no form's copy. */
  readonly editing: SellerVocabularyEditLabels | null;
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(attributes.map((attribute) => [attribute.key, initialDraft(attribute)])),
  );
  const [chosen, setChosen] = useState<readonly string[]>(() =>
    tags.filter((tag) => tag.isSelected).map((tag) => tag.slug),
  );
  const [attributeMessage, setAttributeMessage] = useState<string | null>(null);
  const [tagMessage, setTagMessage] = useState<string | null>(null);
  const [savingAttributes, setSavingAttributes] = useState(false);
  const [savingTags, setSavingTags] = useState(false);

  const update = (key: string, change: Partial<Draft>): void => {
    setDrafts((current) => {
      const existing = current[key] ?? { text: '', boolean: false, options: [] };
      return { ...current, [key]: { ...existing, ...change } };
    });
  };

  async function saveAttributes(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSavingAttributes(true);
    setAttributeMessage(null);
    const answers = attributes.flatMap((attribute) => {
      const answer = answerOf(attribute, drafts[attribute.key] ?? initialDraft(attribute));
      return answer === null ? [] : [answer];
    });
    const outcome = await send(`${path}/attributes`, { answers });
    setSavingAttributes(false);
    if (editLabels !== null) setAttributeMessage(messageFor(outcome, editLabels, editLabels.saved));
    if (outcome.status === 200) router.refresh();
  }

  async function saveTags(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSavingTags(true);
    setTagMessage(null);
    const outcome = await send(`${path}/tags`, { tags: [...chosen] });
    setSavingTags(false);
    if (editLabels !== null) setTagMessage(messageFor(outcome, editLabels, editLabels.tagsSaved));
    if (outcome.status === 200) router.refresh();
  }

  return (
    <>
      <section aria-labelledby="seller-attributes-heading" className="mt-8">
        <h2 id="seller-attributes-heading" className="text-lg font-semibold text-neutral-900">
          {labels.attributesHeading}
        </h2>

        {attributes.length === 0 ? (
          <p role="status" className="mt-2 max-w-prose text-neutral-600">
            {labels.noQuestions}
          </p>
        ) : (
          <>
            <p className={HINT_CLASS}>{labels.attributesIntro}</p>
            {attributes.some((attribute) => attribute.isRequired) ? (
              <p className={HINT_CLASS}>{labels.advisory}</p>
            ) : null}

            {editLabels !== null ? (
              <form onSubmit={saveAttributes} noValidate className="mt-4 max-w-xl space-y-5">
                {attributes.map((attribute) => (
                  <AttributeField
                    key={attribute.key}
                    attribute={attribute}
                    draft={drafts[attribute.key] ?? initialDraft(attribute)}
                    labels={labels}
                    onChange={(change) => update(attribute.key, change)}
                  />
                ))}
                <button className={BUTTON_CLASS} type="submit" disabled={savingAttributes}>
                  {savingAttributes ? editLabels.saving : editLabels.save}
                </button>
                {attributeMessage === null ? null : (
                  <p role="status" className="text-sm text-neutral-700">
                    {attributeMessage}
                  </p>
                )}
              </form>
            ) : (
              <>
                <dl className="mt-4 max-w-xl space-y-3">
                  {attributes.map((attribute) => (
                    <div key={attribute.key}>
                      <dt className="text-sm text-neutral-600">{attribute.label}</dt>
                      <dd className="text-neutral-900">{answerText(attribute, labels)}</dd>
                    </div>
                  ))}
                </dl>
                <p role="status" className={HINT_CLASS}>
                  {labels.notEditable}
                </p>
              </>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="seller-tags-heading" className="mt-8">
        <h2 id="seller-tags-heading" className="text-lg font-semibold text-neutral-900">
          {labels.tagsHeading}
        </h2>

        {tags.length === 0 ? (
          <p role="status" className="mt-2 max-w-prose text-neutral-600">
            {labels.noTags}
          </p>
        ) : editLabels !== null ? (
          <form onSubmit={saveTags} noValidate className="mt-4 max-w-xl space-y-3">
            <p className={HINT_CLASS}>{labels.tagsIntro}</p>
            {tags.map((tag) => (
              <label key={tag.slug} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={chosen.includes(tag.slug)}
                  onChange={(event) =>
                    setChosen((current) =>
                      event.target.checked
                        ? [...current, tag.slug]
                        : current.filter((slug) => slug !== tag.slug),
                    )
                  }
                />
                <span className="text-sm text-neutral-900">{tag.name}</span>
              </label>
            ))}
            <button className={BUTTON_CLASS} type="submit" disabled={savingTags}>
              {savingTags ? editLabels.saving : editLabels.saveTags}
            </button>
            {tagMessage === null ? null : (
              <p role="status" className="text-sm text-neutral-700">
                {tagMessage}
              </p>
            )}
          </form>
        ) : (
          <>
            <p className="mt-2 text-neutral-900">
              {tags
                .filter((tag) => tag.isSelected)
                .map((tag) => tag.name)
                .join(labels.listSeparator) || labels.noAnswer}
            </p>
            <p role="status" className={HINT_CLASS}>
              {labels.notEditable}
            </p>
          </>
        )}
      </section>
    </>
  );
}

/** One field, chosen by the attribute's own data type. */
function AttributeField({
  attribute,
  draft,
  labels,
  onChange,
}: {
  readonly attribute: RenderableAttribute;
  readonly draft: Draft;
  readonly labels: SellerVocabularyLabels;
  readonly onChange: (change: Partial<Draft>) => void;
}) {
  const name = `attribute-${attribute.key}`;
  const title = (
    <>
      {attribute.label}
      {attribute.unit === null ? null : <span className="text-neutral-600"> ({attribute.unit})</span>}
      {attribute.isRequired ? <span className="text-neutral-600"> — {labels.required}</span> : null}
    </>
  );

  if (attribute.dataType === 'boolean') {
    return (
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name={name}
          checked={draft.boolean}
          onChange={(event) => onChange({ boolean: event.target.checked })}
        />
        <span className="text-sm text-neutral-900">{title}</span>
      </label>
    );
  }

  if (attribute.dataType === 'single_select') {
    return (
      <fieldset>
        <legend className={LABEL_CLASS}>{title}</legend>
        <label className="mt-1 flex items-center gap-2">
          <input
            type="radio"
            name={name}
            checked={draft.options.length === 0}
            onChange={() => onChange({ options: [] })}
          />
          <span className="text-sm text-neutral-600">{labels.noAnswer}</span>
        </label>
        {attribute.choices.map((choice) => (
          <label key={choice.value} className="mt-1 flex items-center gap-2">
            <input
              type="radio"
              name={name}
              checked={draft.options[0] === choice.value}
              onChange={() => onChange({ options: [choice.value] })}
            />
            <span className="text-sm text-neutral-900">{choice.label}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  if (attribute.dataType === 'multi_select') {
    return (
      <fieldset>
        <legend className={LABEL_CLASS}>{title}</legend>
        {attribute.choices.map((choice) => (
          <label key={choice.value} className="mt-1 flex items-center gap-2">
            <input
              type="checkbox"
              name={`${name}-${choice.value}`}
              checked={draft.options.includes(choice.value)}
              onChange={(event) =>
                onChange({
                  options: event.target.checked
                    ? [...draft.options, choice.value]
                    : draft.options.filter((value) => value !== choice.value),
                })
              }
            />
            <span className="text-sm text-neutral-900">{choice.label}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  return (
    <label className="block">
      <span className={LABEL_CLASS}>{title}</span>
      <input
        className={FIELD_CLASS}
        name={name}
        value={draft.text}
        onChange={(event) => onChange({ text: event.target.value })}
        {...(attribute.dataType === 'number'
          ? {
              type: 'number',
              step: 'any',
              min: -LISTING_ATTRIBUTE_NUMBER_ABS_MAX,
              max: LISTING_ATTRIBUTE_NUMBER_ABS_MAX,
            }
          : { type: 'text', maxLength: LISTING_ATTRIBUTE_TEXT_MAX })}
      />
    </label>
  );
}

/** What one answer reads as when the listing can no longer be edited. */
function answerText(attribute: RenderableAttribute, labels: SellerVocabularyLabels): string {
  if (attribute.dataType === 'boolean') {
    return attribute.boolean === null ? labels.noAnswer : attribute.boolean ? labels.yes : labels.no;
  }
  if (attribute.dataType === 'number') {
    return attribute.number === null
      ? labels.noAnswer
      : attribute.unit === null
        ? String(attribute.number)
        : `${attribute.number} ${attribute.unit}`;
  }
  if (attribute.dataType === 'text') return attribute.text ?? labels.noAnswer;
  const labelsByValue = new Map(attribute.choices.map((choice) => [choice.value, choice.label]));
  const chosen = attribute.options.map((value) => labelsByValue.get(value) ?? value);
  return chosen.length === 0 ? labels.noAnswer : chosen.join(labels.listSeparator);
}
