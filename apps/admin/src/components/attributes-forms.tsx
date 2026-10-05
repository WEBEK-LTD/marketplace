'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  ATTRIBUTE_DATA_TYPES,
  ATTRIBUTE_KEY_MAX,
  ATTRIBUTE_LABEL_MAX,
  ATTRIBUTE_OPTION_VALUE_MAX,
  ATTRIBUTE_SORT_ORDER_MAX,
  ATTRIBUTE_UNIT_MAX,
  attributeHasOptions,
  type AttributeDataType,
} from '@repo/contracts';

/**
 * The attribute and tag controls.
 *
 * What these forms deliberately do **not** contain:
 *
 * - **No key or data-type field anywhere but the create form.** Both are identity every stored answer refers to,
 *   so a rename is not a control that was left out — the route, the contract and the database function all lack it.
 * - **No value field on an option edit, and no slug field on a tag edit**, for the same reason.
 * - **No active state on any settings form.** Showing or hiding is the one edit a seller and a visitor both notice,
 *   so it is its own request against its own route; a colleague fixing a label cannot publish a field by accident.
 * - **No delete control.** `category_attributes`, sellers' own answers and `listing_tags` all reference these rows
 *   with `ON DELETE RESTRICT`; hiding is the operation that exists, and it keeps every answer.
 * - **No filtering control.** `isFilterable` is recorded and shown as the statement of intent it is; nothing filters
 *   by it in this increment.
 * - **No optimistic state.** Typed text survives a failed request.
 *
 * **Refusals are shown by code**, because three are expected and each means something different: the name is
 * taken, the change would leave sellers unable to answer, or a value is not allowed.
 *
 * **A unit is offered only for a number.** The column allows one on nothing else, so the create form hides the
 * field rather than letting somebody fill in a value the database will refuse.
 */

const BUTTON_CLASS = 'rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const SECONDARY_CLASS =
  'rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 disabled:opacity-60';
const FIELD_CLASS = 'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900';
const LABEL_CLASS = 'block text-sm font-medium text-neutral-700';
const HINT_CLASS = 'mt-1 text-xs text-neutral-500';

interface Outcome {
  readonly status: number | null;
  readonly code: string | null;
}

/** Every label a form needs, resolved on the server so no translation lookup happens in a client bundle. */
export interface VocabularyLabels {
  readonly working: string;
  readonly failed: string;
  readonly keyTaken: string;
  readonly notAnswerable: string;
  readonly valueNotAllowed: string;
}

async function send(
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  body: Record<string, unknown>,
): Promise<Outcome> {
  try {
    const response = await fetch(path, {
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
function messageFor(outcome: Outcome, labels: VocabularyLabels, success: string): string {
  if (outcome.status === 200 || outcome.status === 201) return success;
  if (outcome.code === 'ATTRIBUTE_KEY_TAKEN') return labels.keyTaken;
  if (outcome.code === 'ATTRIBUTE_NOT_ANSWERABLE') return labels.notAnswerable;
  if (outcome.code === 'ATTRIBUTE_VALUE_NOT_ALLOWED') return labels.valueNotAllowed;
  return labels.failed;
}

function Note({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <p className="mt-3 text-sm text-neutral-700" role="status">
      {message}
    </p>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Defining an attribute                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export function AttributeCreateForm({
  labels,
}: {
  readonly labels: VocabularyLabels & {
    key: string;
    keyHint: string;
    dataType: string;
    dataTypeHint: string;
    nameEn: string;
    nameAr: string;
    unit: string;
    unitHint: string;
    isFilterable: string;
    isFilterableHint: string;
    sortOrder: string;
    submit: string;
    created: string;
    typeText: string;
    typeNumber: string;
    typeBoolean: string;
    typeSingleSelect: string;
    typeMultiSelect: string;
  };
}) {
  const router = useRouter();
  const [key, setKey] = useState('');
  const [dataType, setDataType] = useState<AttributeDataType>('text');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [unit, setUnit] = useState('');
  const [isFilterable, setIsFilterable] = useState(true);
  const [sortOrder, setSortOrder] = useState('0');
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const typeLabel = (type: AttributeDataType): string =>
    type === 'text'
      ? labels.typeText
      : type === 'number'
        ? labels.typeNumber
        : type === 'boolean'
          ? labels.typeBoolean
          : type === 'single_select'
            ? labels.typeSingleSelect
            : labels.typeMultiSelect;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const outcome = await send('POST', '/api/attributes', {
      key: key.trim(),
      dataType,
      nameEn: nameEn.trim(),
      nameAr: nameAr.trim(),
      // Only a number may carry one, so the field is not sent at all for anything else.
      ...(dataType === 'number' && unit.trim() !== '' ? { unit: unit.trim() } : {}),
      isFilterable,
      ...(sortOrder === '' ? {} : { sortOrder: Number(sortOrder) }),
    });
    setWorking(false);
    setMessage(messageFor(outcome, labels, labels.created));
    if (outcome.status === 201) {
      // The key is cleared because it can never be reused; the rest is kept, since a run of attributes is
      // usually defined with the same type and ordering.
      setKey('');
      setNameEn('');
      setNameAr('');
      router.refresh();
    }
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.key}</span>
        <input
          className={FIELD_CLASS}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          maxLength={ATTRIBUTE_KEY_MAX}
          required
        />
        <span className={HINT_CLASS}>{labels.keyHint}</span>
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.dataType}</span>
        <select
          className={FIELD_CLASS}
          value={dataType}
          onChange={(event) => setDataType(event.target.value as AttributeDataType)}
        >
          {ATTRIBUTE_DATA_TYPES.map((type) => (
            <option key={type} value={type}>
              {typeLabel(type)}
            </option>
          ))}
        </select>
        <span className={HINT_CLASS}>{labels.dataTypeHint}</span>
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.nameEn}</span>
        <input
          className={FIELD_CLASS}
          value={nameEn}
          onChange={(event) => setNameEn(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.nameAr}</span>
        <input
          className={FIELD_CLASS}
          dir="rtl"
          value={nameAr}
          onChange={(event) => setNameAr(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>

      {dataType === 'number' ? (
        <label className="block">
          <span className={LABEL_CLASS}>{labels.unit}</span>
          <input
            className={FIELD_CLASS}
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            maxLength={ATTRIBUTE_UNIT_MAX}
          />
          <span className={HINT_CLASS}>{labels.unitHint}</span>
        </label>
      ) : null}

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={isFilterable}
          onChange={(event) => setIsFilterable(event.target.checked)}
        />
        <span className="text-sm text-neutral-800">{labels.isFilterable}</span>
      </label>
      <p className={HINT_CLASS}>{labels.isFilterableHint}</p>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.sortOrder}</span>
        <input
          className={FIELD_CLASS}
          type="number"
          min={0}
          max={ATTRIBUTE_SORT_ORDER_MAX}
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
        />
      </label>

      <button className={BUTTON_CLASS} type="submit" disabled={working}>
        {working ? labels.working : labels.submit}
      </button>
      <Note message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Editing one attribute                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export function AttributeSettingsForm({
  definitionId,
  dataType,
  nameEn: initialNameEn,
  nameAr: initialNameAr,
  unit: initialUnit,
  isFilterable: initialIsFilterable,
  sortOrder: initialSortOrder,
  labels,
}: {
  readonly definitionId: string;
  readonly dataType: AttributeDataType;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly unit: string | null;
  readonly isFilterable: boolean;
  readonly sortOrder: number;
  readonly labels: VocabularyLabels & {
    nameEn: string;
    nameAr: string;
    unit: string;
    unitHint: string;
    isFilterable: string;
    isFilterableHint: string;
    sortOrder: string;
    submit: string;
    saved: string;
  };
}) {
  const router = useRouter();
  const [nameEn, setNameEn] = useState(initialNameEn);
  const [nameAr, setNameAr] = useState(initialNameAr);
  const [unit, setUnit] = useState(initialUnit ?? '');
  const [isFilterable, setIsFilterable] = useState(initialIsFilterable);
  const [sortOrder, setSortOrder] = useState(String(initialSortOrder));
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const outcome = await send('PATCH', '/api/attributes', {
      definitionId,
      nameEn: nameEn.trim(),
      nameAr: nameAr.trim(),
      // An empty string clears the unit; it is sent for a number alone, because nothing else may carry one.
      ...(dataType === 'number' ? { unit: unit.trim() } : {}),
      isFilterable,
      sortOrder: sortOrder === '' ? 0 : Number(sortOrder),
    });
    setWorking(false);
    setMessage(messageFor(outcome, labels, labels.saved));
    if (outcome.status === 200) router.refresh();
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.nameEn}</span>
        <input
          className={FIELD_CLASS}
          value={nameEn}
          onChange={(event) => setNameEn(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.nameAr}</span>
        <input
          className={FIELD_CLASS}
          dir="rtl"
          value={nameAr}
          onChange={(event) => setNameAr(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>

      {dataType === 'number' ? (
        <label className="block">
          <span className={LABEL_CLASS}>{labels.unit}</span>
          <input
            className={FIELD_CLASS}
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            maxLength={ATTRIBUTE_UNIT_MAX}
          />
          <span className={HINT_CLASS}>{labels.unitHint}</span>
        </label>
      ) : null}

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={isFilterable}
          onChange={(event) => setIsFilterable(event.target.checked)}
        />
        <span className="text-sm text-neutral-800">{labels.isFilterable}</span>
      </label>
      <p className={HINT_CLASS}>{labels.isFilterableHint}</p>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.sortOrder}</span>
        <input
          className={FIELD_CLASS}
          type="number"
          min={0}
          max={ATTRIBUTE_SORT_ORDER_MAX}
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
        />
      </label>

      <button className={BUTTON_CLASS} type="submit" disabled={working}>
        {working ? labels.working : labels.submit}
      </button>
      <Note message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Showing and hiding                                                                               */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One button, for an attribute, an option or a tag.
 *
 * Shared because the three do the same thing against three routes, and because the sentence a person needs when it
 * is refused is the same in all three: the change would leave a question nobody can answer.
 */
export function VocabularyStateForm({
  path,
  body,
  isActive,
  labels,
}: {
  readonly path: string;
  readonly body: Record<string, string>;
  readonly isActive: boolean;
  readonly labels: VocabularyLabels & { show: string; hide: string; shown: string; hidden: string };
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const outcome = await send('PUT', path, { ...body, isActive: !isActive });
    setWorking(false);
    setMessage(messageFor(outcome, labels, isActive ? labels.hidden : labels.shown));
    if (outcome.status === 200) router.refresh();
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <button className={SECONDARY_CLASS} type="submit" disabled={working}>
        {working ? labels.working : isActive ? labels.hide : labels.show}
      </button>
      <Note message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Options                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export function AttributeOptionCreateForm({
  definitionId,
  labels,
}: {
  readonly definitionId: string;
  readonly labels: VocabularyLabels & {
    value: string;
    valueHint: string;
    labelEn: string;
    labelAr: string;
    sortOrder: string;
    submit: string;
    created: string;
  };
}) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [labelAr, setLabelAr] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const outcome = await send('POST', '/api/attributes/options', {
      definitionId,
      value: value.trim(),
      labelEn: labelEn.trim(),
      labelAr: labelAr.trim(),
      ...(sortOrder === '' ? {} : { sortOrder: Number(sortOrder) }),
    });
    setWorking(false);
    setMessage(messageFor(outcome, labels, labels.created));
    if (outcome.status === 201) {
      setValue('');
      setLabelEn('');
      setLabelAr('');
      router.refresh();
    }
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.value}</span>
        <input
          className={FIELD_CLASS}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={ATTRIBUTE_OPTION_VALUE_MAX}
          required
        />
        <span className={HINT_CLASS}>{labels.valueHint}</span>
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.labelEn}</span>
        <input
          className={FIELD_CLASS}
          value={labelEn}
          onChange={(event) => setLabelEn(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.labelAr}</span>
        <input
          className={FIELD_CLASS}
          dir="rtl"
          value={labelAr}
          onChange={(event) => setLabelAr(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.sortOrder}</span>
        <input
          className={FIELD_CLASS}
          type="number"
          min={0}
          max={ATTRIBUTE_SORT_ORDER_MAX}
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
        />
      </label>

      <button className={BUTTON_CLASS} type="submit" disabled={working}>
        {working ? labels.working : labels.submit}
      </button>
      <Note message={message} />
    </form>
  );
}

export function AttributeOptionSettingsForm({
  definitionId,
  optionId,
  labelEn: initialLabelEn,
  labelAr: initialLabelAr,
  sortOrder: initialSortOrder,
  labels,
}: {
  readonly definitionId: string;
  readonly optionId: string;
  readonly labelEn: string;
  readonly labelAr: string;
  readonly sortOrder: number;
  readonly labels: VocabularyLabels & {
    labelEn: string;
    labelAr: string;
    sortOrder: string;
    submit: string;
    saved: string;
  };
}) {
  const router = useRouter();
  const [labelEn, setLabelEn] = useState(initialLabelEn);
  const [labelAr, setLabelAr] = useState(initialLabelAr);
  const [sortOrder, setSortOrder] = useState(String(initialSortOrder));
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const outcome = await send('PATCH', '/api/attributes/options', {
      definitionId,
      optionId,
      labelEn: labelEn.trim(),
      labelAr: labelAr.trim(),
      sortOrder: sortOrder === '' ? 0 : Number(sortOrder),
    });
    setWorking(false);
    setMessage(messageFor(outcome, labels, labels.saved));
    if (outcome.status === 200) router.refresh();
  }

  return (
    <form className="mt-2 space-y-2" onSubmit={submit}>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.labelEn}</span>
        <input
          className={FIELD_CLASS}
          value={labelEn}
          onChange={(event) => setLabelEn(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.labelAr}</span>
        <input
          className={FIELD_CLASS}
          dir="rtl"
          value={labelAr}
          onChange={(event) => setLabelAr(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.sortOrder}</span>
        <input
          className={FIELD_CLASS}
          type="number"
          min={0}
          max={ATTRIBUTE_SORT_ORDER_MAX}
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
        />
      </label>
      <button className={SECONDARY_CLASS} type="submit" disabled={working}>
        {working ? labels.working : labels.submit}
      </button>
      <Note message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Tags                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export function TagCreateForm({
  labels,
}: {
  readonly labels: VocabularyLabels & {
    slug: string;
    slugHint: string;
    nameEn: string;
    nameAr: string;
    submit: string;
    created: string;
  };
}) {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const outcome = await send('POST', '/api/tags', {
      slug: slug.trim(),
      nameEn: nameEn.trim(),
      nameAr: nameAr.trim(),
    });
    setWorking(false);
    setMessage(messageFor(outcome, labels, labels.created));
    if (outcome.status === 201) {
      setSlug('');
      setNameEn('');
      setNameAr('');
      router.refresh();
    }
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.slug}</span>
        <input
          className={FIELD_CLASS}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          maxLength={50}
          required
        />
        <span className={HINT_CLASS}>{labels.slugHint}</span>
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.nameEn}</span>
        <input
          className={FIELD_CLASS}
          value={nameEn}
          onChange={(event) => setNameEn(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.nameAr}</span>
        <input
          className={FIELD_CLASS}
          dir="rtl"
          value={nameAr}
          onChange={(event) => setNameAr(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>

      <button className={BUTTON_CLASS} type="submit" disabled={working}>
        {working ? labels.working : labels.submit}
      </button>
      <Note message={message} />
    </form>
  );
}

export function TagSettingsForm({
  tagId,
  nameEn: initialNameEn,
  nameAr: initialNameAr,
  labels,
}: {
  readonly tagId: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly labels: VocabularyLabels & { nameEn: string; nameAr: string; submit: string; saved: string };
}) {
  const router = useRouter();
  const [nameEn, setNameEn] = useState(initialNameEn);
  const [nameAr, setNameAr] = useState(initialNameAr);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const outcome = await send('PATCH', '/api/tags', {
      tagId,
      nameEn: nameEn.trim(),
      nameAr: nameAr.trim(),
    });
    setWorking(false);
    setMessage(messageFor(outcome, labels, labels.saved));
    if (outcome.status === 200) router.refresh();
  }

  return (
    <form className="mt-2 space-y-2" onSubmit={submit}>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.nameEn}</span>
        <input
          className={FIELD_CLASS}
          value={nameEn}
          onChange={(event) => setNameEn(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.nameAr}</span>
        <input
          className={FIELD_CLASS}
          dir="rtl"
          value={nameAr}
          onChange={(event) => setNameAr(event.target.value)}
          maxLength={ATTRIBUTE_LABEL_MAX}
          required
        />
      </label>
      <button className={SECONDARY_CLASS} type="submit" disabled={working}>
        {working ? labels.working : labels.submit}
      </button>
      <Note message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* What a category asks for                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export interface AttributeChoice {
  readonly definitionId: string;
  readonly label: string;
  readonly dataType: AttributeDataType;
  readonly isActive: boolean;
  readonly optionCount: number;
}

/**
 * Ask a category for one attribute, or change how it asks.
 *
 * One form for both, because asking for an attribute the category already asks for is a change to how it asks. The
 * choices offered are the whole vocabulary, with a hidden attribute and a select attribute that has no option
 * marked as such: both can be attached, and neither will reach a seller's form until it is answerable.
 */
export function CategoryAttributeAttachForm({
  categoryId,
  choices,
  labels,
}: {
  readonly categoryId: string;
  readonly choices: readonly AttributeChoice[];
  readonly labels: VocabularyLabels & {
    attribute: string;
    isRequired: string;
    isRequiredHint: string;
    isFilterable: string;
    isFilterableHint: string;
    sortOrder: string;
    submit: string;
    saved: string;
    hiddenSuffix: string;
    noOptionsSuffix: string;
    noChoices: string;
  };
}) {
  const router = useRouter();
  const [definitionId, setDefinitionId] = useState(choices[0]?.definitionId ?? '');
  const [isRequired, setIsRequired] = useState(false);
  const [isFilterable, setIsFilterable] = useState(true);
  const [sortOrder, setSortOrder] = useState('0');
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  if (choices.length === 0) return <p className="mt-4 text-sm text-neutral-600">{labels.noChoices}</p>;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const outcome = await send('PUT', '/api/categories/attributes', {
      categoryId,
      definitionId,
      isRequired,
      isFilterable,
      ...(sortOrder === '' ? {} : { sortOrder: Number(sortOrder) }),
    });
    setWorking(false);
    setMessage(messageFor(outcome, labels, labels.saved));
    if (outcome.status === 200) router.refresh();
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <label className="block">
        <span className={LABEL_CLASS}>{labels.attribute}</span>
        <select
          className={FIELD_CLASS}
          value={definitionId}
          onChange={(event) => setDefinitionId(event.target.value)}
        >
          {choices.map((choice) => (
            <option key={choice.definitionId} value={choice.definitionId}>
              {choice.label}
              {choice.isActive ? '' : ` ${labels.hiddenSuffix}`}
              {attributeHasOptions(choice.dataType) && choice.optionCount === 0
                ? ` ${labels.noOptionsSuffix}`
                : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={isRequired} onChange={(event) => setIsRequired(event.target.checked)} />
        <span className="text-sm text-neutral-800">{labels.isRequired}</span>
      </label>
      <p className={HINT_CLASS}>{labels.isRequiredHint}</p>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={isFilterable}
          onChange={(event) => setIsFilterable(event.target.checked)}
        />
        <span className="text-sm text-neutral-800">{labels.isFilterable}</span>
      </label>
      <p className={HINT_CLASS}>{labels.isFilterableHint}</p>

      <label className="block">
        <span className={LABEL_CLASS}>{labels.sortOrder}</span>
        <input
          className={FIELD_CLASS}
          type="number"
          min={0}
          max={ATTRIBUTE_SORT_ORDER_MAX}
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
        />
      </label>

      <button className={BUTTON_CLASS} type="submit" disabled={working}>
        {working ? labels.working : labels.submit}
      </button>
      <Note message={message} />
    </form>
  );
}

/**
 * Stop a category asking for one attribute.
 *
 * A `POST`, because a browser form cannot send a `DELETE`. **No answer is deleted**, and the button says so: the
 * attribute stops being asked, and re-attaching it brings every answer back.
 */
export function CategoryAttributeDetachForm({
  categoryId,
  definitionId,
  labels,
}: {
  readonly categoryId: string;
  readonly definitionId: string;
  readonly labels: VocabularyLabels & { detach: string; detached: string };
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const outcome = await send('POST', '/api/categories/attributes/remove', { categoryId, definitionId });
    setWorking(false);
    setMessage(messageFor(outcome, labels, labels.detached));
    if (outcome.status === 200) router.refresh();
  }

  return (
    <form onSubmit={submit}>
      <button className={SECONDARY_CLASS} type="submit" disabled={working}>
        {working ? labels.working : labels.detach}
      </button>
      <Note message={message} />
    </form>
  );
}
