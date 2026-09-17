export interface ErrorViewProps {
  readonly title: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
}

/** Presentational error message; never shows error details. */
export function ErrorView({ title, retryLabel, onRetry }: ErrorViewProps) {
  return (
    <div role="alert" className="py-12">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <button type="button" onClick={onRetry} className="mt-4 rounded-md border border-neutral-300 px-4 py-2 text-sm">
        {retryLabel}
      </button>
    </div>
  );
}
