import type { ReactNode } from 'react';
import { cx, DISABLED, FOCUS_RING, FOCUS_RING_INVERTED, INTERACTIVE } from './recipes.js';
import { Spinner } from './spinner.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'onInk' | 'onInkGhost';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * The variants, and what each one is for.
 *
 * `primary` is solid ink and is the only filled control on a light surface, which is what makes it findable
 * without colour. `onInk` and `onInkGhost` are its counterparts on an ink band — the inversion is a real pair of
 * variants rather than a `className` override at the call site, so a button on a dark band gets the correct
 * hover, press and focus treatment instead of an approximation.
 *
 * **`danger` carries no red, because there is no red.** The palette has no hue until the owner supplies the two
 * brand colours, so a destructive action is marked by weight instead: a 2px edge where every other control has a
 * hairline, and a full inversion on hover so the commitment is unmistakable at the moment of the click. The
 * label is expected to name the destruction ("Delete listing", never "Confirm"), which is what actually stops a
 * mistake — colour never did that work alone.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-surface-ink text-on-ink shadow-xs hover:bg-ink-body hover:shadow-sm',
  secondary: 'bg-surface-raised text-ink-strong ring-1 ring-edge hover:bg-surface-sunken hover:ring-edge-strong',
  ghost: 'bg-transparent text-ink-body hover:bg-state-hover hover:text-ink-strong',
  danger: 'bg-surface-raised font-semibold text-ink-strong ring-2 ring-edge-strong hover:bg-surface-ink hover:text-on-ink',
  onInk: 'bg-on-ink text-ink-strong hover:bg-surface-sunken',
  onInkGhost: 'bg-transparent text-on-ink ring-1 ring-edge-on-ink hover:bg-state-hover-on-ink hover:ring-edge-on-ink-strong',
};

/**
 * Heights are fixed so a row of mixed controls — button, input, select — lines up on one baseline.
 *
 * `xl` is new in 0110 and exists for one place: the search control in the home page's opening band, where a
 * 48px field looks like a form and a 60px one looks like the point of the page.
 */
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 gap-1.5 px-3.5 text-sm',
  md: 'h-11 gap-2 px-5 text-sm',
  lg: 'h-12 gap-2 px-6 text-base',
  xl: 'h-14 gap-2 px-7 text-base sm:h-[3.75rem] sm:px-8',
};

const BASE =
  'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap active:translate-y-px';

/** The classes a button-shaped element needs, for the rare case that element cannot be a `<button>`. */
export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', fullWidth = false): string {
  const ring = variant === 'onInk' || variant === 'onInkGhost' ? FOCUS_RING_INVERTED : FOCUS_RING;
  return cx(BASE, VARIANTS[variant], SIZES[size], INTERACTIVE, DISABLED, ring, fullWidth && 'w-full');
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
