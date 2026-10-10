import { ADMIN_BUTTON_QUIET } from '../ui';

export interface ErrorViewProps {
  readonly title: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
}

/** Presentational error message; never shows error details. */
export function ErrorView({ title, retryLabel, onRetry }: ErrorViewProps) {
  return (
    <div role="alert" className="py-12">
      <h1 className="text-2xl font-semibold text-ink-strong">{title}</h1>
      <button type="button" onClick={onRetry} className={`${ADMIN_BUTTON_QUIET} mt-4`}>
        {retryLabel}
      </button>
    </div>
  );
}
