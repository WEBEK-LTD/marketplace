'use client';

import './globals.css';

/**
 * The last-resort boundary, for when the locale layout itself fails.
 *
 * It replaces the whole document, so none of the chrome exists here and no translations are available — the
 * two sentences are hard-coded in both languages because there is nowhere to read them from. It imports the
 * stylesheet directly, which is why it can still speak the semantic ladder rather than falling back to raw
 * utilities: an error page that does not look like the product is one more thing wrong at the worst moment.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" dir="ltr">
      <body className="bg-surface-canvas">
        <main className="mx-auto max-w-2xl px-5 py-20 sm:px-8 sm:py-28">
          <span aria-hidden="true" className="block h-0.5 w-16 rounded-full bg-brand-600" />
          <h1 className="mt-8 text-3xl font-semibold text-ink-strong sm:text-4xl">Something went wrong</h1>
          <p lang="ar" dir="rtl" className="mt-3 text-lg text-ink-muted">
            حدث خطأ ما
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-10 inline-flex h-11 items-center justify-center rounded-lg bg-surface-ink px-5 text-sm font-medium text-on-ink transition-colors duration-200 hover:bg-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
