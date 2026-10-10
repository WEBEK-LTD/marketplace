import type { ReactNode } from 'react';
import { cx, FOCUS_RING } from './recipes.js';

export interface ChoiceProps {
  readonly type: 'checkbox' | 'radio';
  readonly name: string;
  readonly value: string;
  readonly children: ReactNode;
  readonly defaultChecked?: boolean;
  readonly disabled?: boolean;
  /** A count or hint shown after the label, in the quieter weight. */
  readonly detail?: ReactNode;
  readonly className?: string;
}

/**
 * A checkbox or a radio, with its label.
 *
 * **The native control, styled with `accent-color`.** Replacing it with a drawn box is the usual approach and
 * costs more than it gives: the platform control already announces itself correctly, works with the keyboard,
 * reaches the right size for a touch target on a phone, and renders in high-contrast mode. `accent-color` tints
 * it to the palette with one declaration and no markup at all.
 *
 * **The whole row is the label**, so the text is a click target and not just the box — which on a filter panel
 * with thirty values is the difference between usable and fiddly on a phone. `py-1.5` keeps each row at a
 * comfortable height without turning the panel into a scroll.
 *
 * `focus-within` carries the shared ring to the row, so keyboard navigation shows the same target the pointer
 * gets, and the ring is the one every other control in the product uses.
 */
export function Choice({
  type,
  name,
  value,
  children,
  defaultChecked = false,
  disabled = false,
  detail,
  className,
}: ChoiceProps) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-baseline gap-2.5 rounded-md py-1.5 text-sm',
        'hover:text-ink-strong',
        'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-primary',
        disabled ? 'cursor-not-allowed text-ink-faint' : 'text-ink-body',
        className,
      )}
    >
      <input
        type={type}
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        disabled={disabled}
        /* `accent-color` tints the platform control; `outline-none` hands the ring to the row above. */
        className={cx('mt-0.5 size-4 shrink-0 accent-ink-strong', FOCUS_RING)}
      />
      <span className="flex-1" dir="auto">
        {children}
      </span>
      {detail === undefined ? null : (
        <span className="shrink-0 text-xs text-ink-muted tabular-nums">{detail}</span>
      )}
    </label>
  );
}

/**
 * A group of choices, with its own legend.
 *
 * A real `<fieldset>` and `<legend>`: a screen reader then announces "Condition, group" before the values, which
 * is the one piece of context that makes a list of twenty ticks navigable. A `div` with a bold heading above it
 * announces nothing.
 */
export function ChoiceGroup({
  legend,
  children,
  hint,
  className,
}: {
  readonly legend: ReactNode;
  readonly children: ReactNode;
  readonly hint?: string;
  readonly className?: string;
}) {
  return (
    <fieldset className={cx('border-t border-hairline pt-4', className)}>
      <legend className="text-sm font-semibold text-ink-strong">{legend}</legend>
      {hint === undefined ? null : <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
      <div className="mt-1.5">{children}</div>
    </fieldset>
  );
}
