'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { adminApiPath } from '../paths';

/**
 * The console's language switch (Phase 7-F).
 *
 * **It writes the profile, because that is where the console's language lives.** v5.2 puts the admin's
 * language in the person's own profile rather than in a cookie or a URL prefix, so this posts to the
 * BFF route that calls the profile operation the API already has. Nothing here stores a preference of
 * its own: the switch changes the account, and the next render reads it back.
 *
 * It sends one field and reads only the status of the answer. There is no token here, no account and no
 * permission — the session is an `HttpOnly` cookie this code cannot read, and the account the server
 * writes is resolved from it.
 *
 * On success the route is refreshed rather than the label being flipped locally, so what a person sees
 * is the language the server stored and not the one this component hoped it would.
 */

export interface LocaleSwitchLabels {
  readonly label: string;
  readonly english: string;
  readonly arabic: string;
  readonly working: string;
  readonly failed: string;
}

export function LocaleSwitch({
  current,
  labels,
}: {
  readonly current: 'en' | 'ar';
  readonly labels: LocaleSwitchLabels;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const target = current === 'ar' ? 'en' : 'ar';
  const targetLabel = target === 'ar' ? labels.arabic : labels.english;

  async function switchTo(): Promise<void> {
    if (pending) return;
    setFailed(false);
    setPending(true);
    try {
      const response = await fetch(adminApiPath('/api/account/locale'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ localeCode: target }),
      });
      if (response.status === 200) {
        router.refresh();
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void switchTo()}
        disabled={pending}
        lang={target}
        aria-label={`${labels.label}: ${targetLabel}`}
        className="rounded-md border border-edge px-3 py-1 text-sm font-medium text-ink-strong disabled:opacity-60"
      >
        {pending ? labels.working : targetLabel}
      </button>
      {failed && (
        <span role="alert" className="text-xs text-ink-strong">
          {labels.failed}
        </span>
      )}
    </span>
  );
}
