'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { buttonClasses, type ButtonSize, type ButtonVariant } from './button.js';
import { cx, FOCUS_RING, SURFACE_POPOVER } from './recipes.js';

export interface DropdownProps {
  /** The trigger's label. */
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Which edge the panel aligns to. `end` is the default, which mirrors correctly in Arabic. */
  readonly align?: 'start' | 'end';
  readonly className?: string;
  readonly 'aria-label'?: string;
}

/**
 * A menu of actions, anchored to its trigger.
 *
 * **This is for actions, not for choosing a value.** A choice of value is a `<select>` — see {@link Select} for
 * why that one stays native. This exists for the cases that are genuinely a menu: an account menu, a row's
 * overflow actions, a language switch.
 *
 * Keyboard behaviour is the reason it is a component rather than a `<details>` element. `<details>` gives
 * open-without-JavaScript and nothing else: no Escape, no click-outside, no roving focus between items. Here:
 *
 *   * **Escape** closes and returns focus to the trigger, which is where a person expects to be.
 *   * **A click or focus outside** closes it, so a menu never outlives the attention that opened it.
 *   * **Arrow keys** move between items and wrap; Home and End jump to the ends.
 *   * Opening with the keyboard focuses the first item; opening with a pointer does not move focus at all.
 *
 * `role="menu"` with `role="menuitem"` children is correct here, unlike on {@link Tabs}, because this really is
 * a menu widget rather than a set of page links wearing a widget's clothes.
 */
export function Dropdown({
  label,
  children,
  variant = 'secondary',
  size = 'md',
  align = 'end',
  className,
  ...aria
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [openedByKeyboard, setOpenedByKeyboard] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      setOpenedByKeyboard(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [],
  );

  // Outside interaction. `pointerdown` rather than `click`, so the menu is gone before the click lands on
  // whatever is underneath — otherwise a person's first click only dismisses the menu and they must click twice.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) close(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [close, open]);

  // Opening with the keyboard puts focus on the first item; opening with the pointer leaves it on the trigger.
  useEffect(() => {
    if (open && openedByKeyboard) focusItem(menuRef.current, 0);
  }, [open, openedByKeyboard]);

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
      setOpenedByKeyboard(true);
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = focusableItems(menuRef.current);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      // Tab leaves the menu rather than cycling inside it: this is a menu, not a dialog.
      close(false);
    }
  };

  return (
    <div ref={containerRef} className={cx('relative inline-block', className)}>
      <button
        ref={triggerRef}
        type="button"
        className={buttonClasses(variant, size)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpen((was) => !was);
          setOpenedByKeyboard(false);
        }}
        onKeyDown={onTriggerKeyDown}
        {...aria}
      >
        {label}
        <Chevron open={open} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          onKeyDown={onMenuKeyDown}
          className={cx(
            'absolute top-full z-30 mt-1 min-w-[12rem] max-w-[min(20rem,calc(100vw-2rem))] overflow-hidden py-1',
            SURFACE_POPOVER,
            align === 'end' ? 'end-0' : 'start-0',
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

const ITEM_CLASSES = `flex w-full items-center gap-2 px-3 py-2 text-start text-sm text-ink-body transition-colors duration-150 hover:bg-surface-muted hover:text-ink-strong ${FOCUS_RING}`;

/** A menu entry that navigates. */
export function DropdownLink({
  href,
  children,
  current = false,
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly current?: boolean;
}) {
  return (
    <a
      href={href}
      role="menuitem"
      aria-current={current ? 'page' : undefined}
      className={cx(ITEM_CLASSES, current && 'font-semibold text-ink-strong')}
    >
      {children}
    </a>
  );
}

/** A menu entry that acts. */
export function DropdownButton({
  children,
  onClick,
  disabled = false,
}: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cx(ITEM_CLASSES, 'disabled:pointer-events-none disabled:text-ink-faint')}
    >
      {children}
    </button>
  );
}

/** A labelled group inside a menu, for when a menu holds two kinds of thing. */
export function DropdownGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="border-t border-hairline py-1 first:border-t-0">
      <p className="px-3 pb-1 text-xs font-medium text-ink-muted">{label}</p>
      {children}
    </div>
  );
}

function focusableItems(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return [];
  return [...root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
}

function focusItem(root: HTMLElement | null, index: number): void {
  focusableItems(root)[index]?.focus();
}

/** The disclosure mark. Rotates to point up while the menu is open, which is the state made visible. */
function Chevron({ open }: { readonly open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        '-mt-0.5 size-2 shrink-0 rotate-45 border-e-2 border-b-2 border-current transition-transform duration-150',
        open && 'mt-0.5 -rotate-135',
      )}
    />
  );
}
