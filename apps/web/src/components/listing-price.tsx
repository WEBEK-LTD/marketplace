import { Money, defineCurrency, toDecimalString } from '@repo/money';
import { PRICE, cx } from '@repo/ui';

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

/**
 * The amount split into its two typographic parts, or null when the listing carries none.
 *
 * Same decision as {@link formatListingAmount} and the same output, only not yet joined into one string: the
 * currency **code** and the **decimal**, with no locale currency formatter picking a symbol or a position. What
 * this adds is the ability to set the two differently — the code as a small raised mark, the amount large and
 * tabular — which is what turns "EGP 2500.00" from a run of text into a composed figure, and which a single
 * string cannot be styled into.
 */
export function formatListingAmountParts(
  priceMinor: string | null,
  currencyCode: string,
  currencyMinorUnit: number,
): { readonly code: string; readonly amount: string } | null {
  if (priceMinor === null) return null;
  try {
    const money = Money.ofMinor(BigInt(priceMinor), defineCurrency(currencyCode, currencyMinorUnit));
    return { code: money.currency.code, amount: toDecimalString(money) };
  } catch {
    return null;
  }
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
      <span className="text-base font-semibold text-ink-strong">{amount ?? labels.contactForPrice}</span>
      {isNegotiable && amount !== null ? (
        <span className="rounded-md bg-surface-muted px-2 py-0.5 text-xs text-ink-body">{labels.negotiable}</span>
      ) : null}
    </p>
  );
}

export interface PriceLockupProps {
  readonly priceMinor: string | null;
  readonly currencyCode: string;
  readonly currencyMinorUnit: number;
  readonly labels: Pick<ListingPriceLabels, 'contactForPrice'>;
  /** `card` on a grid, `detail` on an item's own page. */
  readonly size?: 'card' | 'detail';
  readonly className?: string;
}

/**
 * The price, set as the figure it is — the product's signature typographic detail (0110).
 *
 * **The price is the largest thing on a card**, larger than the title, because a marketplace is scanned by
 * price. 0109 set it at 18px bold under an 18px title and the card had no focal point at all; a grid of those
 * is the "rows of identical boxes" the direction was rejected for.
 *
 * The currency code is set as a small raised mark by `.mp-currency` rather than as part of the number. That is
 * not decoration: it lets the amount keep the full optical weight of the line, and it makes a column of prices
 * align on their first digit instead of on three letters of varying width. `tabular-nums` finishes the job, so
 * the decimals line up down the grid in both languages — Arabic pages in this product use Western digits, and
 * a column that does not align looks careless in either.
 *
 * Where there is no amount, "Contact for price" is prose and is set as prose. Setting those words at 28px would
 * be shouting a non-answer, and it would break the alignment of every real price beside it.
 */
export function PriceLockup({
  priceMinor,
  currencyCode,
  currencyMinorUnit,
  labels,
  size = 'card',
  className,
}: PriceLockupProps) {
  const parts = formatListingAmountParts(priceMinor, currencyCode, currencyMinorUnit);
  if (parts === null) {
    return <p className={cx(PRICE.absent, className)}>{labels.contactForPrice}</p>;
  }
  return (
    <p className={cx(size === 'detail' ? PRICE.detail : PRICE.card, className)}>
      {/*
        One accessible string, read as "EGP 2500.00" — and that space is load-bearing.

        The mark is a styled span inside the same paragraph rather than a `<sup>`, because a real superscript
        element changes how the number is announced. But splitting the string across two nodes also deletes the
        space between them unless it is put back: the first build of this component rendered text content of
        "EGP2500.00", which is what a screen reader reads out and what a person gets when they copy the price.
        The visual gap comes from the mark's own margin; this space is for everything that reads the text.
      */}
      <span className="mp-currency">{parts.code}</span>
      {' '}
      {parts.amount}
    </p>
  );
}
