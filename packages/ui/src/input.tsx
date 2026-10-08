import { cx, DISABLED, FOCUS_RING } from './recipes.js';

/**
 * The field shell, shared by every control a person types or chooses in.
 *
 * Input, textarea and select all use it, which is why a text field and a dropdown sitting side by side in a
 * filter bar are exactly the same height and share one border, one radius and one focus ring.
 *
 * `error` raises the border to 2px rather than recolouring it: the palette is monochrome, so weight is the
 * emphasis. The 2px replaces the 1px rather than adding to it, so the control does not change size and a form
 * does not reflow when it is refused.
 */
export function fieldClasses(options: { readonly error?: boolean; readonly className?: string } = {}): string {
  return cx(
    'w-full rounded-md bg-neutral-0 text-base text-neutral-900 transition-colors duration-150',
    'placeholder:text-neutral-400',
    options.error === true ? 'border-2 border-neutral-900' : 'border border-neutral-300 hover:border-neutral-400',
    FOCUS_RING,
    DISABLED,
    options.className,
  );
}

/** Heights match {@link buttonClasses}, so controls and buttons line up in a row. */
const CONTROL_HEIGHT = 'h-10 px-3';

export type InputType = 'text' | 'search' | 'email' | 'tel' | 'password' | 'number' | 'url';

export interface InputProps {
  readonly id: string;
  readonly name: string;
  readonly type?: InputType;
  readonly defaultValue?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly error?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly readOnly?: boolean;
  readonly autoComplete?: string;
  readonly inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'search' | 'url';
  readonly maxLength?: number;
  /** A length the browser refuses below, so a contract minimum is enforced before a request is made. */
  readonly minLength?: number;
  readonly min?: string;
  readonly max?: string;
  readonly step?: string;
  readonly dir?: 'ltr' | 'rtl' | 'auto';
  readonly className?: string;
  readonly 'aria-invalid'?: true;
  readonly 'aria-describedby'?: string;
  readonly 'aria-label'?: string;
  readonly onChange?: (value: string) => void;
}

/**
 * A single-line field.
 *
 * `dir="auto"` is available and is the right choice for any field whose content may not be in the page's
 * language — a seller's name, a search query, a URL. The page is Arabic right-to-left, a URL is not, and letting
 * the browser decide per value is the only way both read correctly.
 */
export function Input({ error = false, className, onChange, ...rest }: InputProps) {
  return (
    <input
      className={fieldClasses({ error, className: cx(CONTROL_HEIGHT, className) })}
      {...(onChange === undefined ? {} : { onChange: (event) => onChange(event.target.value) })}
      {...rest}
    />
  );
}

export interface TextareaProps {
  readonly id: string;
  readonly name: string;
  readonly rows?: number;
  readonly defaultValue?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly error?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly className?: string;
  readonly 'aria-invalid'?: true;
  readonly 'aria-describedby'?: string;
  readonly 'aria-label'?: string;
  readonly onChange?: (value: string) => void;
}

/** A multi-line field. Same shell, free height, with the vertical padding a paragraph needs. */
export function Textarea({ rows = 4, error = false, className, onChange, ...rest }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      className={fieldClasses({ error, className: cx('resize-y px-3 py-2 leading-normal', className) })}
      {...(onChange === undefined ? {} : { onChange: (event) => onChange(event.target.value) })}
      {...rest}
    />
  );
}
