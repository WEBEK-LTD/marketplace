import type { ReactNode } from 'react';
import { cx, DISABLED, FOCUS_RING, INTERACTIVE } from './recipes.js';
import { Spinner } from './spinner.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * The variants, and what each one is for.
 *
 * **`danger` carries no red, because there is no red.** The palette is monochrome until the owner supplies the
 * two brand colours, so a destructive action is marked by weight instead of hue: a 2px border where every other
 * control has a hairline, and a full inversion on hover so the commitment is unmistakable at the moment of the
 * click. The label is expected to name the destruction ("Delete listing", never "Confirm"), which is what
 * actually stops a mistake — colour never did that work alone.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border border-neutral-900 bg-neutral-900 text-neutral-0 hover:border-neutral-800 hover:bg-neutral-800',
  secondary: 'border border-neutral-300 bg-neutral-0 text-neutral-900 hover:border-neutral-400 hover:bg-neutral-50',
  ghost: 'border border-transparent bg-transparent text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900',
  danger: 'border-2 border-neutral-900 bg-neutral-0 font-semibold text-neutral-900 hover:bg-neutral-900 hover:text-neutral-0',
};

/** Heights are fixed so a row of mixed controls — button, input, select — lines up on one baseline. */
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-sm',
  md: 'h-10 gap-2 px-4 text-sm',
  lg: 'h-12 gap-2 px-5 text-base',
};

const BASE = 'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap';

/** The classes a button-shaped element needs, for the rare case that element cannot be a `<button>`. */
export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', fullWidth = false): string {
  return cx(BASE, VARIANTS[variant], SIZES[size], INTERACTIVE, DISABLED, FOCUS_RING, fullWidth && 'w-full');
}

export interface ButtonProps {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly disabled?: boolean;
  /**
   * Whether the action this button started is still running.
   *
   * Pending implies disabled, so a second click cannot submit a form twice, and it is announced rather than only
   * drawn: `aria-busy` tells a screen reader the control is working, and `pendingLabel` replaces the visible text
   * so the change is not carried by a spinner alone.
   */
  readonly pending?: boolean;
  readonly pendingLabel?: string;
  readonly fullWidth?: boolean;
  readonly name?: string;
  readonly value?: string;
  readonly form?: string;
  readonly onClick?: () => void;
  readonly 'aria-label'?: string;
  readonly 'aria-controls'?: string;
  readonly 'aria-expanded'?: boolean;
  readonly 'aria-haspopup'?: 'dialog' | 'menu' | 'listbox' | 'true';
}

/**
 * The product's one button.
 *
 * Every actionable control in the public marketplace is this component or {@link ButtonLink}, so the hover, the
 * press, the focus ring and the disabled treatment are the same everywhere a person can act.
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  disabled = false,
  pending = false,
  pendingLabel,
  fullWidth = false,
  name,
  value,
  form,
  onClick,
  ...aria
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, fullWidth)}
      disabled={disabled || pending}
      aria-busy={pending ? true : undefined}
      {...(name === undefined ? {} : { name })}
      {...(value === undefined ? {} : { value })}
      {...(form === undefined ? {} : { form })}
      {...(onClick === undefined ? {} : { onClick })}
      {...aria}
    >
      {pending ? (
        <>
          <Spinner />
          {pendingLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}

export interface ButtonLinkProps {
  readonly href: string;
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly fullWidth?: boolean;
  readonly 'aria-label'?: string;
  readonly rel?: string;
}

/**
 * A navigation that looks like a button.
 *
 * An anchor, not a button with an onClick: it is a link, so it must open in a new tab on a middle click, appear
 * in the browser's history, and work with JavaScript unavailable. Keeping the two components apart is what stops
 * that distinction from eroding.
 */
export function ButtonLink({
  href,
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  rel,
  ...aria
}: ButtonLinkProps) {
  return (
    <a href={href} className={buttonClasses(variant, size, fullWidth)} {...(rel === undefined ? {} : { rel })} {...aria}>
      {children}
    </a>
  );
}
