import type { WriteFailureLabels } from './messaging-write';

/**
 * The contact action's labels (Phase 5-E).
 *
 * Deliberately **not** in the `'use client'` module beside the button. The pages that render the button
 * are server components, and they are the ones that hold the translations, so the function that turns
 * those translations into a label set has to be callable from the server. A client module's exports are
 * not: Next.js replaces them with client references, and calling one from a page is an error at render
 * time rather than at build time.
 */

export interface StartConversationLabels extends WriteFailureLabels {
  readonly action: string;
  readonly working: string;
  /** Shown once the BFF has said the visitor is not signed in. */
  readonly signIn: string;
}

/**
 * Builds the full label set from the four sentences a *start* can actually produce.
 *
 * Starting a conversation carries no message body and addresses nothing that can be closed, so `invalid`
 * and `closed` are unreachable here and fold into the generic sentence rather than inventing copy for
 * states this action cannot reach. A seller who cannot be contacted and a blocked pair share one
 * sentence, which is also what the API does: the difference is not the caller's business.
 */
export function startConversationLabels(input: {
  readonly action: string;
  readonly working: string;
  readonly signIn: string;
  readonly cannotMessage: string;
  readonly failed: string;
}): StartConversationLabels {
  return {
    action: input.action,
    working: input.working,
    signIn: input.signIn,
    invalid: input.failed,
    signedOut: input.signIn,
    unavailable: input.cannotMessage,
    closed: input.failed,
    blocked: input.cannotMessage,
    throttled: input.failed,
    failed: input.failed,
  };
}
