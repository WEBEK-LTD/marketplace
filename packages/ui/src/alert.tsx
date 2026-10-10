import type { ReactNode } from 'react';
import { cx, TYPE } from './recipes.js';

export type AlertTone = 'info' | 'warning' | 'error' | 'success';

/**
 * The four tones, carried by structure because they cannot be carried by colour.
 *
 * There is no red, amber or green in this palette — the two brand slots are owner-supplied and currently grey —
 * so an alert distinguishes itself by **border weight on the inline-start edge** plus **an icon shape** plus
 * **the words**. WCAG forbids relying on colour alone in any case, so a design that cannot use colour simply
 * arrives at the compliant answer first.
 *
 *   * `info` — hairline all round on a recessed surface. The quietest; a note, not a problem.
 *   * `success` — same surface, a 2px start edge, a check. Something finished.
 *   * `warning` — 2px start edge and a stronger border all round. Something needs attention but nothing failed.
 *   * `error` — a 2px border all round on the page surface, so it reads as raised out of the form it refused.
 *
 * Severity is also announced, not just drawn: `error` and `warning` get `role="alert"` with
 * `aria-live="assertive"`, the quieter two get `role="status"`. That is the difference between interrupting a
 * screen-reader user and letting them reach the message in their own time.
 */
const TONES: Record<AlertTone, string> = {
  info: 'border border-hairline bg-surface-sunken',
  success: 'border border-hairline border-s-2 border-s-edge-strong bg-surface-sunken',
  warning: 'border border-edge border-s-2 border-s-edge-strong bg-surface-sunken',
  error: 'border-2 border-edge-strong bg-surface-raised',
};

export interface AlertProps {
  readonly tone?: AlertTone;
  /** A short statement of what happened. Omit for a single-sentence alert and use `children` alone. */
  readonly title?: string;
  readonly children?: ReactNode;
  /** An action that resolves the alert — "Try again", "Review the form". */
  readonly action?: ReactNode;
  /**
   * Whether this alert announces itself.
   *
   * `auto` is the default and the usual case. `polite` keeps the announcement but drops the interruption: a
   * listing, service or seller marked no-longer-available is a fact about the thing a person asked for, not an
   * emergency, and the catalogue surfaces have always announced it as a `status`. `off` is for an alert rendered
   * **inside a live region that already exists** — a form that keeps one permanently mounted status region at its top, for instance. Two nested live
   * regions announce the same sentence twice, and a `role="alert"` inside a `role="status"` also overrides the
   * politeness the outer region deliberately chose. Turning this off keeps the visual treatment and lets the
   * region that owns the announcement keep owning it.
   */
  readonly announce?: 'auto' | 'polite' | 'off';
  readonly className?: string;
}

/**
 * A message about something that happened.
 *
 * The copy rules matter as much as the shape: an alert says what went wrong and what to do about it, in the
 * interface's voice. It does not apologise, it is not vague, and it never says "something went wrong" when it
 * knows what did.
 */
export function Alert({ tone = 'info', title, children, action, announce = 'auto', className }: AlertProps) {
  const assertive = tone === 'error' || tone === 'warning';
  return (
    <div
      {...(announce === 'off'
        ? {}
        : announce === 'polite'
          ? { role: 'status' as const, 'aria-live': 'polite' as const }
          : {
              role: assertive ? ('alert' as const) : ('status' as const),
              'aria-live': assertive ? ('assertive' as const) : ('polite' as const),
            })}
      className={cx('flex items-start gap-3 rounded-lg px-4 py-3', TONES[tone], className)}
    >
      <AlertMark tone={tone} />
      <div className="flex-1 space-y-1">
        {title === undefined ? null : <p className="text-sm font-semibold text-ink-strong">{title}</p>}
        {children === undefined ? null : <div className={TYPE.hint}>{children}</div>}
      </div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * The tone's mark: a shape, not a colour.
 *
 * Drawn from borders rather than imported, for the same reason the dialog's close mark is — this primitive is
 * used on the error and unavailable states of every public route, and it must not make `@repo/ui` depend on an
 * icon library. A check for success, a bar-and-dot for warning and error (the familiar exclamation), and a dot
 * for info. All `aria-hidden`: the role and the words carry the meaning.
 */
function AlertMark({ tone }: { readonly tone: AlertTone }) {
  if (tone === 'success') {
    return (
      <span aria-hidden="true" className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <span className="mt-[-2px] size-2.5 rotate-45 border-e-2 border-b-2 border-edge-strong" />
      </span>
    );
  }
  if (tone === 'info') {
    return (
      <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full border-2 border-edge" />
    );
  }
  return (
    <span aria-hidden="true" className="mt-0.5 flex size-4 shrink-0 flex-col items-center gap-0.5">
      <span className="h-2 w-0.5 bg-surface-ink" />
      <span className="size-0.5 rounded-full bg-surface-ink" />
    </span>
  );
}
