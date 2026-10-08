import { Button, EmptyState } from '@repo/ui';

export interface ErrorViewProps {
  readonly title: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
}

/**
 * What a page shows when it threw.
 *
 * **It never shows error details**, and that is the whole contract of the component: no message, no stack, no
 * digest. A thrown error can carry anything, including an internal identifier or part of a query, and a boundary
 * is exactly the place where that would reach a visitor.
 *
 * Drawn as the `unavailable` empty state, which is the same treatment every failing read in the product gets —
 * a recessed surface that announces itself, visibly different from "this matched nothing". A person who hits a
 * crashed page and a person who hits a failing catalogue read should recognise the same thing has happened.
 *
 * The retry is the one action, and it is a button rather than a link because `reset()` re-renders the segment
 * rather than navigating.
 */
export function ErrorView({ title, retryLabel, onRetry }: ErrorViewProps) {
  return (
    <div className="py-16">
      <EmptyState
        title={title}
        tone="unavailable"
        action={
          <Button variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        }
      />
    </div>
  );
}
