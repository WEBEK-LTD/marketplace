'use client';

import './globals.css';

// Last-resort boundary when the locale layout itself fails; no translations are available here.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" dir="ltr">
      <body>
        <main className="mx-auto max-w-6xl px-4 py-12">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p lang="ar" dir="rtl">حدث خطأ ما</p>
          <button type="button" onClick={() => reset()} className="mt-4 rounded-md border border-neutral-300 px-4 py-2 text-sm">
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
