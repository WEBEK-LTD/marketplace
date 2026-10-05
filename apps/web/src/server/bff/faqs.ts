import 'server-only';
import {
  FaqTopicSchema,
  PublicFaqsResponseSchema,
  publicLocaleOf,
  type PublicFaqEntry,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

/**
 * The BFF half of the public help centre (0095).
 *
 * The browser never reaches the API and never reaches Supabase; it asks this origin, and this module makes the one
 * internal hop with the BFF credential attached. It carries no session, because the questions are the same for
 * everyone.
 *
 * **The topic is the page's own `page_key`** (owner decision 1). The caller passes it; nothing here resolves an
 * address, and a value that could not be a topic is refused before a request is made rather than asked about.
 *
 * The answer is **validated** rather than forwarded, with the shared contract — so the page and the API cannot
 * drift apart silently.
 *
 * **Null means the entries could not be read; an empty array means nothing is published.** The two are different
 * answers: a page whose topic has nothing published renders no section (owner decision 2), and a page whose
 * questions could not be read renders the page itself and no section either — but the distinction is kept, because
 * silently calling an outage "nothing published" is how a broken read becomes invisible.
 */

export interface FaqsFetchOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

/** The published entries of one topic, or null when they could not be read at all. */
export async function readFaqs(
  topic: string | null,
  locale: string,
  options: FaqsFetchOptions = {},
): Promise<readonly PublicFaqEntry[] | null> {
  const parsed = FaqTopicSchema.safeParse(topic ?? undefined);
  // A page with no key, or a key that is not a topic, has no help section to show. Not an outage: there is
  // nothing to ask about.
  if (!parsed.success) return [];

  const query = new URLSearchParams({ topic: parsed.data, locale: publicLocaleOf(locale) });

  let config: ReturnType<typeof readBffConfig>;
  try {
    config = readBffConfig(options.env);
  } catch {
    return null;
  }

  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/faqs?${query.toString()}`, { method: 'GET' });
  } catch {
    return null;
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return null;
  }

  try {
    const parsedBody = PublicFaqsResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsedBody.success ? parsedBody.data.entries : null;
  } catch {
    return null;
  }
}
