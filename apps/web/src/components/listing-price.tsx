import { Money, defineCurrency, toDecimalString } from '@repo/money';

/**
 * A listing's price (Phase 4-B).
 *
 * Three states, all of them the owner's:
 *
 *   * an amount, formatted by the money package from the stored minor units and the currency's own
 *     minor unit — never converted, never re-denominated, always the currency the seller listed in;
 *   * **"Contact for price"** when there is no amount, which is how a custom service with no fixed
 *     price reaches a page;
 *   * **"Negotiable"** alongside an amount when the listing says so.
 *
 * The amount is rendered as `<code> <decimal>` rather than with a locale currency formatter: picking a
 * symbol, a position and a digit style per language is a display decision this slice does not own, and
 * D15 keeps digit style configurable. The code is unambiguous in both languages meanwhile.
 */

export interface ListingPriceLabels {
  readonly contactForPrice: string;
  readonly negotiable: string;
}

export interface ListingPriceProps {
  readonly priceMinor: string | null;
  readonly currencyCode: string;
  readonly currencyMinorUnit: number;
  readonly isNegotiable: boolean;
  readonly labels: ListingPriceLabels;
}

/** The amount alone, or null when the listing carries none. */
export function formatListingAmount(
  priceMinor: string | null,
  currencyCode: string,
  currencyMinorUnit: number,
): string | null {
  if (priceMinor === null) return null;
  try {
    const money = Money.ofMinor(BigInt(priceMinor), defineCurrency(currencyCode, currencyMinorUnit));
    return `${money.currency.code} ${toDecimalString(money)}`;
  } catch {
    // An amount the money package will not accept is not shown as a broken string.
    return null;
  }
}

export function ListingPrice({
  priceMinor,
  currencyCode,
  currencyMinorUnit,
  isNegotiable,
  labels,
}: ListingPriceProps) {
  const amount = formatListingAmount(priceMinor, currencyCode, currencyMinorUnit);

  return (
    <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-base font-semibold text-neutral-900">{amount ?? labels.contactForPrice}</span>
      {isNegotiable && amount !== null ? (
        <span className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-700">
          {labels.negotiable}
        </span>
      ) : null}
    </p>
  );
}
