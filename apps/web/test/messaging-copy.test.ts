import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { startConversationLabels } from '../src/components/start-conversation-labels';

/**
 * The messaging copy and the one pure decision the contact action makes (Phase 5-E).
 *
 * The composer, the controls and the contact button all call `useRouter()`, so they are rendered by the
 * real app in `messaging-pages.test.ts` rather than in isolation here — the same division this project
 * already uses for the recovery forms. What belongs here is what needs no router: the label mapping, and
 * the copy itself, which the owner approved sentence by sentence and which must stay in step across the
 * two locales.
 */

const M = en.Messages;
const S = en.Session;

describe('the labels a contact action can show', () => {
  const labels = startConversationLabels({
    action: M.contactSeller,
    working: M.working,
    signIn: S.signIn,
    cannotMessage: M.cannotMessage,
    failed: M.actionFailed,
  });

  it('shows the action, the in-flight word and the way back in', () => {
    expect(labels.action).toBe('Message seller');
    expect(labels.working).toBe(M.working);
    expect(labels.signIn).toBe('Sign in');
  });

  it('collapses the refusals a start cannot reach onto the generic sentence', () => {
    // Starting a conversation carries no body and addresses nothing closable, so neither state is
    // reachable and neither gets invented copy.
    expect(labels.invalid).toBe(M.actionFailed);
    expect(labels.closed).toBe(M.actionFailed);
    expect(labels.throttled).toBe(M.actionFailed);
    expect(labels.failed).toBe(M.actionFailed);
  });

  it('says one thing for a seller who cannot be contacted and for a blocked pair', () => {
    expect(labels.blocked).toBe(M.cannotMessage);
    expect(labels.unavailable).toBe(M.cannotMessage);
    expect(labels.blocked).toBe(labels.unavailable);
  });

  it('turns a signed-out answer into the way in rather than an error', () => {
    expect(labels.signedOut).toBe(S.signIn);
  });
});

describe('the copy', () => {
  it('carries the same keys in English and Arabic', () => {
    expect(Object.keys(ar.Messages).sort()).toEqual(Object.keys(en.Messages).sort());
  });

  it('has a distinct, non-empty Arabic value for every English one', () => {
    for (const key of Object.keys(en.Messages) as Array<keyof typeof en.Messages>) {
      const english = en.Messages[key];
      const arabic = (ar.Messages as Record<string, string>)[key];
      expect(arabic, key).toBeTruthy();
      expect(arabic, key).not.toBe(english);
    }
  });

  it('keeps the approved wording for the composer, the controls and attribution', () => {
    expect(M.send).toBe('Send');
    expect(M.composerPlaceholder).toBe('Write a message...');
    expect(M.mute).toBe('Mute conversation');
    expect(M.unmute).toBe('Unmute conversation');
    expect(M.leave).toBe('Leave conversation');
    expect(M.you).toBe('You');
    expect(M.otherParty).toBe('Other participant');
  });

  it('has copy for every write state the surface can reach', () => {
    for (const key of [
      'sending',
      'sendFailed',
      'tooLong',
      'markRead',
      'close',
      'leftHint',
      'closedHint',
      'actionFailed',
      'working',
      'contactSeller',
    ] as const) {
      expect(M[key], key).toBeTruthy();
    }
  });

  it('offers no wording for an operation that does not exist', () => {
    const values = JSON.stringify(en.Messages).toLowerCase();
    for (const absent of ['reopen', 'edit message', 'delete message', 'attach']) {
      expect(values, absent).not.toContain(absent);
    }
  });
});
