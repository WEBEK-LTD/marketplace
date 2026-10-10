'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Button } from './button.js';
import { cx, TYPE } from './recipes.js';

export type DialogPlacement = 'center' | 'drawer';

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
  /** The actions row. Omitted for a dialog that only informs. */
  readonly footer?: ReactNode;
  /**
   * `center` is a dialog; `drawer` is the same thing docked to the inline-end edge, full height.
   *
   * One component for both, because they are one behaviour — a layer that owns the screen until it is dismissed —
   * wearing two shapes. Keeping them apart would mean two focus implementations, and the second would be the one
   * with the bug.
   */
  readonly placement?: DialogPlacement;
  /** The accessible name of the close control, in the reader's language. */
  readonly closeLabel: string;
  readonly className?: string;
}

/**
 * A modal layer, built on the platform's `<dialog>`.
 *
 * **`showModal()` rather than a hand-rolled overlay**, and that is the whole reason this component is short.
 * The element gives us, correctly and for free, the things a custom modal gets wrong: focus moves into the
 * dialog and is trapped there, the rest of the page becomes inert to both the pointer and the accessibility
 * tree, Escape dismisses it, it renders in the top layer so no ancestor's `overflow` or `z-index` can clip it,
 * and focus returns to the trigger on close. A `div` with `role="dialog"` would need every one of those
 * re-implemented.
 *
 * What is left to do by hand is the two things the element does not decide: dismissing on a click outside the
 * panel, and keeping React's `open` prop and the element's own state in step — the element can close itself
 * (Escape, the close button's `formmethod="dialog"`), so its `close` event has to tell the caller.
 *
 * The backdrop and the element's reset live in `globals.css`: `::backdrop` is not reachable from a utility class,
 * and the nonce-based CSP admits no inline styles.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  placement = 'center',
  closeLabel,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  // The element's state follows the prop. `showModal` throws if it is already open, so both are guarded.
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  // The element can close itself — Escape, or the browser's own dismiss. The caller has to hear about it, or the
  // prop and reality diverge and the next `open` does nothing.
  const handleClose = useCallback(() => {
    if (open) onClose();
  }, [onClose, open]);

  /**
   * A click outside the panel.
   *
   * The event target is the `<dialog>` itself only when the pointer landed on the backdrop — anything inside the
   * panel targets the panel's own descendants. That identity check is the whole test, and it is why the panel is
   * a real child element rather than the dialog's own padding box.
   */
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDialogElement>) => {
      if (event.target === ref.current) onClose();
    },
    [onClose],
  );

  const titleId = `${placement}-title`;

  return (
    <dialog
      ref={ref}
      onClose={handleClose}
      onClick={handleClick}
      aria-labelledby={titleId}
      className={cx(
        'mp-dialog text-ink-strong',
        placement === 'drawer' ? 'mp-dialog-drawer' : 'mp-dialog-center',
      )}
    >
      <div
        className={cx(
          'flex flex-col bg-surface-raised',
          placement === 'drawer'
            ? 'h-full w-[min(26rem,100vw)] border-s border-hairline shadow-lg'
            : 'max-h-[85vh] w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-hairline shadow-lg',
          className,
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <h2 id={titleId} className={TYPE.h3}>
            {title}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={closeLabel}>
            <CloseMark />
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer === undefined ? null : (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline bg-surface-sunken px-5 py-4">
            {footer}
          </footer>
        )}
      </div>
    </dialog>
  );
}

/**
 * The close mark, drawn with two rotated rules.
 *
 * Two spans rather than an icon import, so the one primitive every overlay depends on pulls in no icon library
 * and `@repo/ui` keeps React as its only dependency.
 */
function CloseMark() {
  return (
    <span aria-hidden="true" className="relative block size-4">
      <span className="absolute top-1/2 start-0 h-0.5 w-4 rotate-45 bg-current" />
      <span className="absolute top-1/2 start-0 h-0.5 w-4 -rotate-45 bg-current" />
    </span>
  );
}
