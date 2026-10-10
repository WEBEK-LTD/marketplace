import { cx } from './recipes.js';
import { fieldClasses } from './input.js';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly id: string;
  readonly name: string;
  readonly options: readonly SelectOption[];
  readonly defaultValue?: string;
  readonly value?: string;
  /** Shown as a disabled first option when nothing is chosen yet. */
  readonly placeholder?: string;
  readonly error?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly className?: string;
  readonly 'aria-invalid'?: true;
  readonly 'aria-describedby'?: string;
  readonly 'aria-label'?: string;
  readonly onChange?: (value: string) => void;
}

/**
 * A native `<select>`, deliberately.
 *
 * A custom listbox would let us draw the menu, and it would also mean re-implementing keyboard navigation, type
 * ahead, the mobile wheel picker and the screen-reader semantics that the platform already gets right. The
 * filters and the sort control on the catalogue are exactly where a person is moving fast, on a phone, in either
 * language — so the native control wins, and {@link Dropdown} exists for the cases that are genuinely menus of
 * actions rather than choices of value.
 *
 * The chevron is drawn with borders on a pseudo-element-free wrapper span rather than a background image, because
 * a `background-image: url(data:…)` would have to come from a style attribute, and the nonce-based CSP admits no
 * inline styles. `appearance-none` removes the platform arrow so the two cannot both appear; `pe-9` leaves room
 * for ours on whichever side the writing direction puts it.
 */
export function Select({ options, placeholder, error = false, className, onChange, ...rest }: SelectProps) {
  return (
    <span className="relative block w-full">
      <select
        className={cx(fieldClasses({ error }), 'h-10 appearance-none ps-3 pe-9', className)}
        {...(onChange === undefined ? {} : { onChange: (event) => onChange(event.target.value) })}
        {...rest}
      >
        {placeholder === undefined ? null : (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled === true}>
            {option.label}
          </option>
        ))}
      </select>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute end-3 top-1/2 -mt-1 size-2 rotate-45 border-e-2 border-b-2 border-edge"
      />
    </span>
  );
}
