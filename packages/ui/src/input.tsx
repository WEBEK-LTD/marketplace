import { cx, DISABLED, FOCUS_RING, INTERACTIVE } from './recipes.js';

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
export function fieldClasses(
  options: { readonly error?: boolean; readonly bare?: boolean; readonly className?: string } = {},
): string {
  /*
    `bare` is a field that has no shell of its own because something around it is the control.

    The one case is the fused search bar: a rounded container holds the field and its submit button, takes the
    ring, and takes the focus ring through `FOCUS_WITHIN` — so the two read as one bar rather than as two
    unrelated white boxes sitting next to each other, which is exactly what the home page showed. The field must
    therefore draw no ring and no focus outline of its own; both would appear *inside* the bar's own edge.

    This is an option on the shared recipe rather than a `className` override at the call site on purpose.
    Overriding would mean emitting `ring-1` and `ring-0` together and relying on which rule Tailwind happens to
    order last, which is not a thing a design system should depend on.
  */
  if (options.bare === true) {
    return cx(
      'w-full min-w-0 bg-transparent text-base text-ink-strong placeholder:text-ink-faint',
      'outline-none focus:outline-none',
      DISABLED,
      options.className,
    );
  }
  return cx(
    'w-full rounded-lg bg-surface-raised text-base text-ink-strong',
    'placeholder:text-ink-faint',
    // A ring rather than a border: it does not take part in layout, so a field and a button of the same
    // declared height are actually the same height, which a 1px border makes false.
    options.error === true ? 'ring-2 ring-edge-strong' : 'ring-1 ring-edge hover:ring-edge-strong',
    INTERACTIVE,
    FOCUS_RING,
    DISABLED,
    options.className,
  );
}

/** Heights match {@link buttonClasses}, so controls and buttons line up in a row. */
const CONTROL_HEIGHT = 'h-11 px-3.5';

/** The home page's opening band, where the field is the point of the page rather than part of a form. */
export const FIELD_HERO = 'h-14 px-5 text-base sm:h-[3.75rem] sm:px-6 sm:text-lg';

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
  /**
   * `bare` drops the field's own shell for a field that sits inside a control — the fused search bar.
   *
   * The container draws the edge and takes the focus ring, so the field inside it must draw neither.
   */
  readonly bare?: boolean;
}

/**
 * A single-line field.
 *
 * `dir="auto"` is available and is the right choice for any field whose content may not be in the page's
 * language — a seller's name, a search query, a URL. The page is Arabic right-to-left, a URL is not, and letting
 * the browser decide per value is the only way both read correctly.
 */
export function Input({ error = false, bare = false, className, onChange, ...rest }: InputProps) {
  return (
    <input
      className={fieldClasses({ error, bare, className: cx(bare ? '' : CONTROL_HEIGHT, className) })}
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
