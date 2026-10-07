import { Heading } from '@repo/ui';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import {
  attributeHasOptions,
  type AdminAttributeDefinition,
  type AdminAttributeOption,
  type AdminCategoryAttribute,
  type AdminTag,
} from '@repo/contracts';
import {
  readAttributeDetail,
  readAttributeVocabulary,
  readCategoryAttributes,
  readTags,
  type AttributesResult,
} from '../server/bff';
import { currentStaffSession } from '../server/current-staff';
import {
  AttributeCreateForm,
  AttributeOptionCreateForm,
  AttributeOptionSettingsForm,
  AttributeSettingsForm,
  CategoryAttributeAttachForm,
  CategoryAttributeDetachForm,
  TagCreateForm,
  TagSettingsForm,
  VocabularyStateForm,
  type AttributeChoice,
  type VocabularyLabels,
} from './attributes-forms';
import { adminPath } from '../paths';

/**
 * The attribute and tag vocabulary, and what each category asks for.
 *
 * **Every panel renders inside its page's `RequireStaff` gate**, so a colleague who may not open the section
 * receives a refusal and no data — not hidden data, no data.
 *
 * **The controls are rendered from the server's answer, not from a role.** The two vocabularies have no read key of
 * their own, so a caller who reaches them may manage them; the category's attribute panel is the one place the two
 * differ, and its `canManage` is the API's answer about `catalog.category.manage` rather than a guess made here.
 *
 * **Both vocabularies are shown whole, including the hidden.** A console that listed only what sellers can see
 * could not be used to bring an attribute back.
 *
 * **The counts are shown because they are what makes a decision informed**: how many categories ask for an
 * attribute, how many sellers have answered it, and how many listings carry a tag. Hiding any of these destroys
 * nothing, and the screens say so rather than leaving somebody to find out.
 *
 * **There is no rename control and no delete control** anywhere here, because no such route exists.
 */

const CARD = 'mt-6 rounded-lg border border-neutral-200 bg-white p-5';
const TABLE = 'mt-4 w-full border-collapse text-left text-sm';
const TH = 'border-b border-neutral-200 pb-2 pr-4 font-medium text-neutral-600';
const TD = 'border-b border-neutral-100 py-2 pr-4 align-top text-neutral-900';

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not data. */
async function problem<T>(result: AttributesResult<T>): Promise<string | null> {
  const t = await getTranslations('Attributes');
  if (result.kind === 'ok') return null;
  if (result.kind === 'unauthenticated') return t('sessionExpired');
  if (result.kind === 'notFound') return t('notFoundBody');
  if (result.kind === 'invalid') return t('invalidBody');
  return t('unavailable');
}

function Message({ tone, title, body }: { tone: 'empty' | 'error'; title: string; body: string }) {
  return (
    <div
      className={`mt-4 rounded-md border p-4 ${
        tone === 'error' ? 'border-red-200 bg-red-50' : 'border-neutral-200 bg-neutral-50'
      }`}
    >
      <p className="font-medium text-neutral-900">{title}</p>
      <p className="mt-1 text-sm text-neutral-700">{body}</p>
    </div>
  );
}

/** Whether this caller holds a key. Asked once, used to decide whether a control exists at all. */
async function holds(permission: string): Promise<boolean> {
  const session = await currentStaffSession();
  return session.kind === 'ok' && session.session.permissions.includes(permission);
}

/** The refusal sentences every form shares. */
async function sharedLabels(): Promise<VocabularyLabels> {
  const t = await getTranslations('Attributes');
  return {
    working: t('working'),
    failed: t('failed'),
    keyTaken: t('keyTaken'),
    notAnswerable: t('notAnswerable'),
    valueNotAllowed: t('valueNotAllowed'),
  };
}

async function stateLabels(): Promise<VocabularyLabels & {
  show: string;
  hide: string;
  shown: string;
  hidden: string;
}> {
  const t = await getTranslations('Attributes');
  return {
    ...(await sharedLabels()),
    show: t('show'),
    hide: t('hide'),
    shown: t('shown'),
    hidden: t('hiddenNow'),
  };
}

/** The name of a data type, in the reader's language. */
async function typeName(dataType: AdminAttributeDefinition['dataType']): Promise<string> {
  const t = await getTranslations('Attributes');
  if (dataType === 'text') return t('typeText');
  if (dataType === 'number') return t('typeNumber');
  if (dataType === 'boolean') return t('typeBoolean');
  if (dataType === 'single_select') return t('typeSingleSelect');
  return t('typeMultiSelect');
}

/* ------------------------------------------------------------------------------------------------ */
/* The attribute vocabulary                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export async function AttributeVocabulary() {
  const t = await getTranslations('Attributes');
  const result = await readAttributeVocabulary({ cookieHeader: await cookieHeader() });

  if (result.kind !== 'ok') {
    const failure = await problem(result);
    return (
      <section className={CARD}>
        <Heading level={2}>{t('vocabularyHeading')}</Heading>
        <Message
          tone={result.kind === 'notFound' ? 'empty' : 'error'}
          title={result.kind === 'notFound' ? t('notFoundTitle') : t('unavailableTitle')}
          body={failure ?? t('unavailable')}
        />
      </section>
    );
  }

  const { attributes } = result.data;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('vocabularyHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('vocabularyNote')}</p>

      {attributes.length === 0 ? (
        <Message tone="empty" title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnName')}</th>
              <th className={TH}>{t('columnType')}</th>
              <th className={TH}>{t('columnState')}</th>
              <th className={TH}>{t('columnOrder')}</th>
              <th className={TH}>{t('columnUse')}</th>
            </tr>
          </thead>
          <tbody>
            {attributes.map((attribute) => (
              <AttributeRow key={attribute.definitionId} attribute={attribute} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

async function AttributeRow({ attribute }: { readonly attribute: AdminAttributeDefinition }) {
  const t = await getTranslations('Attributes');
  const needsOption = attributeHasOptions(attribute.dataType) && attribute.optionCount === 0;

  return (
    <tr>
      <td className={TD}>
        <Link className="underline hover:no-underline" href={adminPath(`/catalog/attributes/${attribute.definitionId}`)}>
          {attribute.nameEn}
        </Link>
        <span className="mt-1 block text-xs text-neutral-500">{attribute.key}</span>
        <span className="mt-1 block text-xs text-neutral-500" dir="rtl">
          {attribute.nameAr}
        </span>
      </td>
      <td className={TD}>
        {await typeName(attribute.dataType)}
        {attribute.unit === null ? null : <span className="block text-xs text-neutral-500">{attribute.unit}</span>}
        {attributeHasOptions(attribute.dataType) ? (
          <span className="block text-xs text-neutral-500">
            {t('optionCount', { count: attribute.optionCount })}
          </span>
        ) : null}
      </td>
      <td className={TD}>
        {attribute.isActive ? t('stateShown') : t('stateHidden')}
        {needsOption ? <span className="block text-xs text-amber-700">{t('needsOption')}</span> : null}
        {attribute.isFilterable ? (
          <span className="block text-xs text-neutral-500">{t('filterableMark')}</span>
        ) : null}
      </td>
      <td className={TD}>{attribute.sortOrder}</td>
      <td className={TD}>
        <span className="block">{t('categoryCount', { count: attribute.categoryCount })}</span>
        <span className="block text-xs text-neutral-500">{t('answerCount', { count: attribute.answerCount })}</span>
      </td>
    </tr>
  );
}

export async function AttributeCreatePanel() {
  const t = await getTranslations('Attributes');

  return (
    <section className={CARD}>
      <Heading level={2}>{t('createHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('createNote')}</p>
      <AttributeCreateForm
        labels={{
          ...(await sharedLabels()),
          key: t('keyLabel'),
          keyHint: t('keyHint'),
          dataType: t('dataTypeLabel'),
          dataTypeHint: t('dataTypeHint'),
          nameEn: t('nameEnLabel'),
          nameAr: t('nameArLabel'),
          unit: t('unitLabel'),
          unitHint: t('unitHint'),
          isFilterable: t('filterableLabel'),
          isFilterableHint: t('filterableHint'),
          sortOrder: t('sortOrderLabel'),
          submit: t('createSubmit'),
          created: t('created'),
          typeText: t('typeText'),
          typeNumber: t('typeNumber'),
          typeBoolean: t('typeBoolean'),
          typeSingleSelect: t('typeSingleSelect'),
          typeMultiSelect: t('typeMultiSelect'),
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One attribute                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export async function AttributeDetailView({ definitionId }: { readonly definitionId: string }) {
  const t = await getTranslations('Attributes');
  const result = await readAttributeDetail(definitionId, { cookieHeader: await cookieHeader() });

  if (result.kind !== 'ok') {
    const failure = await problem(result);
    return (
      <Message
        tone={result.kind === 'notFound' ? 'empty' : 'error'}
        title={result.kind === 'notFound' ? t('notFoundTitle') : t('unavailableTitle')}
        body={failure ?? t('unavailable')}
      />
    );
  }

  const { attribute, options, canManage } = result.data;
  const hasOptions = attributeHasOptions(attribute.dataType);

  return (
    <>
      <section className={CARD}>
        <Heading level={2}>{attribute.nameEn}</Heading>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <Fact label={t('keyLabel')} value={attribute.key} />
          <Fact label={t('columnType')} value={await typeName(attribute.dataType)} />
          <Fact label={t('unitLabel')} value={attribute.unit ?? t('noUnit')} />
          <Fact label={t('columnState')} value={attribute.isActive ? t('stateShown') : t('stateHidden')} />
          <Fact label={t('filterableLabel')} value={attribute.isFilterable ? t('yes') : t('no')} />
          <Fact label={t('columnOrder')} value={String(attribute.sortOrder)} />
          <Fact label={t('categoryCountLabel')} value={String(attribute.categoryCount)} />
          <Fact label={t('answerCountLabel')} value={String(attribute.answerCount)} />
        </dl>
        <p className="mt-3 text-sm text-neutral-600">{t('identityNote')}</p>

        {canManage ? (
          <VocabularyStateForm
            path="/api/attributes/state"
            body={{ definitionId: attribute.definitionId }}
            isActive={attribute.isActive}
            labels={await stateLabels()}
          />
        ) : (
          <p className="mt-4 text-sm text-neutral-600">{t('readOnlyNote')}</p>
        )}
      </section>

      {canManage ? (
        <section className={CARD}>
          <Heading level={2}>{t('settingsHeading')}</Heading>
          <p className="mt-1 text-sm text-neutral-600">{t('settingsNote')}</p>
          <AttributeSettingsForm
            definitionId={attribute.definitionId}
            dataType={attribute.dataType}
            nameEn={attribute.nameEn}
            nameAr={attribute.nameAr}
            unit={attribute.unit}
            isFilterable={attribute.isFilterable}
            sortOrder={attribute.sortOrder}
            labels={{
              ...(await sharedLabels()),
              nameEn: t('nameEnLabel'),
              nameAr: t('nameArLabel'),
              unit: t('unitLabel'),
              unitHint: t('unitHint'),
              isFilterable: t('filterableLabel'),
              isFilterableHint: t('filterableHint'),
              sortOrder: t('sortOrderLabel'),
              submit: t('saveSubmit'),
              saved: t('saved'),
            }}
          />
        </section>
      ) : null}

      {hasOptions ? (
        <section className={CARD}>
          <Heading level={2}>{t('optionsHeading')}</Heading>
          <p className="mt-1 text-sm text-neutral-600">{t('optionsNote')}</p>

          {options.length === 0 ? (
            <Message tone="empty" title={t('noOptionsTitle')} body={t('noOptionsBody')} />
          ) : (
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TH}>{t('columnOption')}</th>
                  <th className={TH}>{t('columnState')}</th>
                  <th className={TH}>{t('columnChosen')}</th>
                </tr>
              </thead>
              <tbody>
                {options.map((option) => (
                  <OptionRow
                    key={option.optionId}
                    definitionId={attribute.definitionId}
                    option={option}
                    canManage={canManage}
                  />
                ))}
              </tbody>
            </table>
          )}

          {canManage ? (
            <AttributeOptionCreateForm
              definitionId={attribute.definitionId}
              labels={{
                ...(await sharedLabels()),
                value: t('optionValueLabel'),
                valueHint: t('optionValueHint'),
                labelEn: t('optionLabelEn'),
                labelAr: t('optionLabelAr'),
                sortOrder: t('sortOrderLabel'),
                submit: t('addOptionSubmit'),
                created: t('optionCreated'),
              }}
            />
          ) : null}
        </section>
      ) : null}
    </>
  );
}

async function OptionRow({
  definitionId,
  option,
  canManage,
}: {
  readonly definitionId: string;
  readonly option: AdminAttributeOption;
  readonly canManage: boolean;
}) {
  const t = await getTranslations('Attributes');

  return (
    <tr>
      <td className={TD}>
        <span className="block font-medium">{option.labelEn}</span>
        <span className="block text-xs text-neutral-500">{option.value}</span>
        <span className="block text-xs text-neutral-500" dir="rtl">
          {option.labelAr}
        </span>
        {canManage ? (
          <AttributeOptionSettingsForm
            definitionId={definitionId}
            optionId={option.optionId}
            labelEn={option.labelEn}
            labelAr={option.labelAr}
            sortOrder={option.sortOrder}
            labels={{
              ...(await sharedLabels()),
              labelEn: t('optionLabelEn'),
              labelAr: t('optionLabelAr'),
              sortOrder: t('sortOrderLabel'),
              submit: t('saveSubmit'),
              saved: t('saved'),
            }}
          />
        ) : null}
      </td>
      <td className={TD}>
        {option.isActive ? t('stateShown') : t('stateHidden')}
        {canManage ? (
          <VocabularyStateForm
            path="/api/attributes/options/state"
            body={{ definitionId, optionId: option.optionId }}
            isActive={option.isActive}
            labels={await stateLabels()}
          />
        ) : null}
      </td>
      <td className={TD}>{t('answerCount', { count: option.answerCount })}</td>
    </tr>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-neutral-600">{label}</dt>
      <dd className="text-neutral-900">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Tags                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

export async function TagVocabulary() {
  const t = await getTranslations('Attributes');
  const result = await readTags({ cookieHeader: await cookieHeader() });

  if (result.kind !== 'ok') {
    const failure = await problem(result);
    return (
      <section className={CARD}>
        <Heading level={2}>{t('tagsHeading')}</Heading>
        <Message
          tone={result.kind === 'notFound' ? 'empty' : 'error'}
          title={result.kind === 'notFound' ? t('notFoundTitle') : t('unavailableTitle')}
          body={failure ?? t('unavailable')}
        />
      </section>
    );
  }

  const { tags, canManage } = result.data;

  return (
    <section className={CARD}>
      <Heading level={2}>{t('tagsHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('tagsNote')}</p>

      {tags.length === 0 ? (
        <Message tone="empty" title={t('noTagsTitle')} body={t('noTagsBody')} />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnTag')}</th>
              <th className={TH}>{t('columnState')}</th>
              <th className={TH}>{t('columnUsage')}</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => (
              <TagRow key={tag.tagId} tag={tag} canManage={canManage} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

async function TagRow({ tag, canManage }: { readonly tag: AdminTag; readonly canManage: boolean }) {
  const t = await getTranslations('Attributes');

  return (
    <tr>
      <td className={TD}>
        <span className="block font-medium">{tag.nameEn}</span>
        <span className="block text-xs text-neutral-500">{tag.slug}</span>
        <span className="block text-xs text-neutral-500" dir="rtl">
          {tag.nameAr}
        </span>
        {canManage ? (
          <TagSettingsForm
            tagId={tag.tagId}
            nameEn={tag.nameEn}
            nameAr={tag.nameAr}
            labels={{
              ...(await sharedLabels()),
              nameEn: t('nameEnLabel'),
              nameAr: t('nameArLabel'),
              submit: t('saveSubmit'),
              saved: t('saved'),
            }}
          />
        ) : null}
      </td>
      <td className={TD}>
        {tag.isActive ? t('stateShown') : t('stateHidden')}
        {canManage ? (
          <VocabularyStateForm
            path="/api/tags/state"
            body={{ tagId: tag.tagId }}
            isActive={tag.isActive}
            labels={await stateLabels()}
          />
        ) : null}
      </td>
      <td className={TD}>{t('usageCount', { count: tag.usageCount })}</td>
    </tr>
  );
}

export async function TagCreatePanel() {
  const t = await getTranslations('Attributes');

  return (
    <section className={CARD}>
      <Heading level={2}>{t('createTagHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('createTagNote')}</p>
      <TagCreateForm
        labels={{
          ...(await sharedLabels()),
          slug: t('tagSlugLabel'),
          slugHint: t('tagSlugHint'),
          nameEn: t('nameEnLabel'),
          nameAr: t('nameArLabel'),
          submit: t('createTagSubmit'),
          created: t('tagCreated'),
        }}
      />
    </section>
  );
}

async function CategoryAttributeRow({
  categoryId,
  attribute,
  canManage,
}: {
  readonly categoryId: string;
  readonly attribute: AdminCategoryAttribute;
  readonly canManage: boolean;
}) {
  const t = await getTranslations('Attributes');

  return (
    <tr>
      <td className={TD}>
        <span className="block font-medium">{attribute.nameEn}</span>
        <span className="block text-xs text-neutral-500">{attribute.key}</span>
      </td>
      <td className={TD}>{await typeName(attribute.dataType)}</td>
      <td className={TD}>
        <span className="block">{attribute.isRequired ? t('askedRequired') : t('askedOptional')}</span>
        {attribute.isRequired ? (
          <span className="block text-xs text-neutral-500">{t('advisoryNote')}</span>
        ) : null}
        {attribute.isActive ? null : (
          <span className="block text-xs text-amber-700">{t('attachedButHidden')}</span>
        )}
        {attribute.isFilterable ? (
          <span className="block text-xs text-neutral-500">{t('filterableMark')}</span>
        ) : null}
      </td>
      <td className={TD}>{attribute.sortOrder}</td>
      {canManage ? (
        <td className={TD}>
          <CategoryAttributeDetachForm
            categoryId={categoryId}
            definitionId={attribute.definitionId}
            labels={{ ...(await sharedLabels()), detach: t('detachSubmit'), detached: t('detached') }}
          />
        </td>
      ) : null}
    </tr>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* What one category asks for                                                                        */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The panel on a category's own screen.
 *
 * Gated twice over: the page's own `catalog.category.read`, and `canManage`, which is the API's answer about
 * `catalog.category.manage`. A colleague who maintains the vocabulary but does not manage categories sees what this
 * category asks for and no controls — which is the distinction `category_attributes`' write policy makes.
 */
export async function CategoryAttributePanel({ categoryId }: { readonly categoryId: string }) {
  const t = await getTranslations('Attributes');
  const cookie = await cookieHeader();
  const result = await readCategoryAttributes(categoryId, { cookieHeader: cookie });

  if (result.kind !== 'ok') {
    const failure = await problem(result);
    return (
      <section className={CARD}>
        <Heading level={2}>{t('categoryHeading')}</Heading>
        <Message
          tone={result.kind === 'notFound' ? 'empty' : 'error'}
          title={result.kind === 'notFound' ? t('notFoundTitle') : t('unavailableTitle')}
          body={failure ?? t('unavailable')}
        />
      </section>
    );
  }

  const { attributes, canManage } = result.data;

  // The vocabulary is read only to offer choices, and only to somebody who may attach one. A colleague without
  // the attribute key sees an empty list rather than a failure: the API answers 404 and the panel still works.
  let choices: readonly AttributeChoice[] = [];
  if (canManage && (await holds('catalog.attribute.manage'))) {
    const vocabulary = await readAttributeVocabulary({ cookieHeader: cookie });
    if (vocabulary.kind === 'ok') {
      choices = vocabulary.data.attributes.map((attribute) => ({
        definitionId: attribute.definitionId,
        label: `${attribute.nameEn} (${attribute.key})`,
        dataType: attribute.dataType,
        isActive: attribute.isActive,
        optionCount: attribute.optionCount,
      }));
    }
  }

  return (
    <section className={CARD}>
      <Heading level={2}>{t('categoryHeading')}</Heading>
      <p className="mt-1 text-sm text-neutral-600">{t('categoryNote')}</p>

      {attributes.length === 0 ? (
        <Message tone="empty" title={t('noCategoryAttributesTitle')} body={t('noCategoryAttributesBody')} />
      ) : (
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>{t('columnName')}</th>
              <th className={TH}>{t('columnType')}</th>
              <th className={TH}>{t('columnAsked')}</th>
              <th className={TH}>{t('columnOrder')}</th>
              {canManage ? <th className={TH}>{t('columnAction')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {attributes.map((attribute) => (
              <CategoryAttributeRow
                key={attribute.definitionId}
                categoryId={categoryId}
                attribute={attribute}
                canManage={canManage}
              />
            ))}
          </tbody>
        </table>
      )}

      {canManage && choices.length === 0 ? <p className="mt-4 text-sm text-neutral-600">{t('noChoices')}</p> : null}

      {canManage && choices.length > 0 ? (
        <CategoryAttributeAttachForm
          categoryId={categoryId}
          choices={choices}
          labels={{
            ...(await sharedLabels()),
            attribute: t('attributeLabel'),
            isRequired: t('requiredLabel'),
            isRequiredHint: t('requiredHint'),
            isFilterable: t('filterableLabel'),
            isFilterableHint: t('filterableHint'),
            sortOrder: t('sortOrderLabel'),
            submit: t('attachSubmit'),
            saved: t('attached'),
            hiddenSuffix: t('hiddenSuffix'),
            noOptionsSuffix: t('noOptionsSuffix'),
            noChoices: t('noChoices'),
          }}
        />
      ) : (
        <p className="mt-4 text-sm text-neutral-600">{t('categoryReadOnlyNote')}</p>
      )}
    </section>
  );
}
