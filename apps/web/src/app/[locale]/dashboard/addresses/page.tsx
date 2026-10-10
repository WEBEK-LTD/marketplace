import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { DeleteAddress } from '../../../../components/account-actions';
import {
  AccountEmpty,
  AccountError,
  AccountSkeleton,
  AddressSummary,
  type AddressCopy,
} from '../../../../components/account-views';
import {
  EditAddress,
  NewAddress,
  type AddressFormLabels,
  type CountryOption,
} from '../../../../components/address-form';
import { RequireSession } from '../../../../components/require-session';
import { readAddresses, readCountries } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Addresses');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The address book (Phase 7-E).
 *
 * **Nothing here is connected to checkout or to an order.** Shipping is Phase 8; an address on this
 * surface is a record the person keeps about themselves, and the page says so rather than implying a
 * delivery that does not exist yet. There is no rate, no method and no estimate anywhere on it.
 *
 * **The country list comes from the server**, with the one flag D17's trigger actually tests, so a
 * person choosing a country for delivery is told before they submit. The rule itself stays in the
 * database, where it was written.
 *
 * **What crosses into the client.** The add and edit forms and the remove button. The form carries the
 * fields a person is editing, which it must in order to let them edit; the rendered address a person
 * reads is produced on the server.
 */
export default async function AddressesPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
}) {
  const [{ locale }, t] = await Promise.all([params, getTranslations('Addresses')]);
  const prefix = locale === 'ar' ? '/ar' : '';

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('intro')}</p>

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <ListSection base={`${prefix}/dashboard/addresses`} locale={locale} t={t} />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'Addresses'>>>;

function formLabels(t: Translate): AddressFormLabels {
  return {
    label: t('label'),
    labelHint: t('labelHint'),
    purpose: t('purpose'),
    purposeShipping: t('purposeShipping'),
    purposeBilling: t('purposeBilling'),
    purposeBoth: t('purposeBoth'),
    recipientName: t('recipientName'),
    phone: t('phone'),
    phoneHint: t('phoneHint'),
    country: t('country'),
    countryNotShippable: t('countryNotShippable'),
    governorate: t('governorate'),
    city: t('city'),
    district: t('district'),
    streetAddress: t('streetAddress'),
    building: t('building'),
    apartment: t('apartment'),
    postalCode: t('postalCode'),
    landmark: t('landmark'),
    defaultShipping: t('defaultShipping'),
    defaultBilling: t('defaultBilling'),
    save: t('save'),
    saving: t('saving'),
    saved: t('saved'),
    cancel: t('cancel'),
    required: t('required'),
    invalidPhone: t('invalidPhone'),
    invalid: t('invalid'),
    missing: t('missing'),
    signedOut: t('signedOut'),
    failed: t('failed'),
    notShippable: t('notShippable'),
  };
}

function summaryCopy(t: Translate): AddressCopy {
  return {
    listLabel: t('listLabel'),
    defaultShipping: t('defaultShipping'),
    defaultBilling: t('defaultBilling'),
    purpose: {
      shipping: t('purposeShipping'),
      billing: t('purposeBilling'),
      both: t('purposeBoth'),
    },
  };
}

async function ListSection({
  base,
  locale,
  t,
}: {
  readonly base: string;
  readonly locale: Locale;
  readonly t: Translate;
}) {
  const requestHeaders = await headers();
  const cookieHeader = requestHeaders.get('cookie');

  // Two independent reads. A country list that failed must not take the address book down with it, so
  // the list is rendered either way and the form is offered only when there is something to choose from.
  const [addresses, countries] = await Promise.all([
    readAddresses({ cookieHeader }),
    readCountries({ cookieHeader }),
  ]);

  if (addresses.kind !== 'ok') {
    return <AccountError title={t('error')} retry={t('retry')} href={base} />;
  }

  const options: readonly CountryOption[] =
    countries.kind === 'ok'
      ? countries.data.items.map((country) => ({
          code: country.code,
          name: locale === 'ar' ? country.nameAr : country.nameEn,
          isMarketplaceEnabled: country.isMarketplaceEnabled,
        }))
      : [];
  const defaultCountry = options.find((country) => country.isMarketplaceEnabled)?.code ?? options[0]?.code ?? '';
  const labels = formLabels(t);
  const copy = summaryCopy(t);

  return (
    <>
      {options.length > 0 && (
        <NewAddress labels={labels} countries={options} addLabel={t('add')} defaultCountry={defaultCountry} />
      )}

      {addresses.data.items.length === 0 ? (
        <AccountEmpty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <ul className="mt-6 space-y-3" aria-label={t('listLabel')}>
          {addresses.data.items.map((address) => (
            <li key={address.id} className="rounded-lg border border-hairline p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <AddressSummary address={address} copy={copy} />
                </div>
                <span className="flex flex-wrap items-center gap-2">
                  {options.length > 0 && (
                    <EditAddress
                      labels={labels}
                      countries={options}
                      editLabel={t('edit')}
                      initial={{
                        id: address.id,
                        label: address.label ?? '',
                        purpose: address.purpose,
                        recipientName: address.recipientName,
                        phoneE164: address.phoneE164,
                        countryCode: address.countryCode,
                        governorate: address.governorate,
                        city: address.city,
                        district: address.district ?? '',
                        streetAddress: address.streetAddress,
                        building: address.building ?? '',
                        apartment: address.apartment ?? '',
                        postalCode: address.postalCode ?? '',
                        landmark: address.landmark ?? '',
                        isDefaultShipping: address.isDefaultShipping,
                        isDefaultBilling: address.isDefaultBilling,
                      }}
                    />
                  )}
                  <DeleteAddress
                    addressId={address.id}
                    copy={{ remove: t('remove'), working: t('working'), failed: t('failed') }}
                  />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
