import type { ReactNode } from 'react';
import { cx, TYPE } from './recipes.js';

export interface FormFieldProps {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
  /** Help text shown under the control, before any error. */
  readonly hint?: string;
  /** The problem with the current value. Its presence is what puts the field into its error state. */
  readonly error?: string;
  readonly required?: boolean;
  /** The word for "required", in the reader's language. Supplied, never assumed. */
  readonly requiredLabel?: string;
  readonly className?: string;
}

/**
 * A label, a control, its help text and its error — wired together.
 *
 * **This component is the form-state contract**, and the wiring is the point of it. A field in error has to say
 * so three ways at once, and getting one of the three wrong is the usual way an accessible form stops being
 * accessible:
 *
 *   1. **Visibly** — the control's border goes to 2px `neutral-900`, which is the system's emphasis. There is no
 *      red to use, so the error is marked by weight, and never by colour alone in any case.
 *   2. **Programmatically** — the control is given `aria-invalid` and `aria-describedby`, so a screen reader
 *      reads the problem as part of the field rather than leaving it as orphaned text nearby.
 *   3. **In words** — the message says what is wrong, in the interface's voice. It does not apologise and it is
 *      not vague; "Enter a price above 0" is a field error, "Invalid input" is not.
 *
 * The control receives the aria wiring from {@link fieldAria}, which the caller spreads onto it — this component
 * cannot reach into an arbitrary child to set attributes, and a helper that returns them is honest about that.
 *
 * `aria-live` on the error: a message that appears after a submission has to be announced, or a keyboard user
 * who has moved focus away never learns the form was refused.
 */
export function FormField({
  id,
  label,
  children,
  hint,
  error,
  required = false,
  requiredLabel,
  className,
}: FormFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className={TYPE.label}>
        {label}
        {required && requiredLabel !== undefined ? (
          <span className="ms-1 font-normal text-ink-muted">({requiredLabel})</span>
        ) : null}
      </label>
      {children}
      {hint !== undefined && error === undefined ? (
        <p id={hintId} className={TYPE.hint}>
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} aria-live="polite" className="text-sm font-medium leading-normal text-ink-strong">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The attributes a control inside a {@link FormField} needs, so the two cannot disagree about the ids.
 *
 * Spread onto the `<input>`, `<select>` or `<textarea>`: `fieldAria('price', { error })`.
 */
export function fieldAria(
  id: string,
  options: { readonly hint?: string; readonly error?: string; readonly required?: boolean } = {},
): {
  readonly id: string;
  readonly 'aria-invalid'?: true;
  readonly 'aria-describedby'?: string;
  readonly required?: true;
} {
  const describedBy = options.error !== undefined ? `${id}-error` : options.hint !== undefined ? `${id}-hint` : undefined;
  return {
    id,
    ...(options.error === undefined ? {} : { 'aria-invalid': true as const }),
    ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
    ...(options.required === true ? { required: true as const } : {}),
  };
}
