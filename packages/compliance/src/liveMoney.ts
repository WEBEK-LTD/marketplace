import { LEGAL_REVIEW_STATUS } from './status.js';
import { rulesBlockingLiveMoney } from './register.js';

/**
 * The live-money guard, and an honest statement of what it can and cannot do.
 *
 * **What it is.** A declaration, callable from a future increment, that an operation moves real money and is
 * therefore refused while the review is provisional. It names the database writers that create permanent
 * financial records so that a caller can assert against the list rather than remembering it.
 *
 * **What it is not.** This package has no database access, imports nothing, and cannot prevent anybody from
 * calling a writer. The real enforcement is elsewhere and was built long before this layer: `app_system` and
 * `app_worker` hold no table privileges and reach the database only through named definer functions;
 * `finance.settlement_posting_enabled` ships false so no settlement journal posts; the ledger and audit log
 * are append-only. Those are the controls. This guard is a seatbelt in application code, not the brakes.
 *
 * **Why the list matters even so.** The ledger is append-only and corrections are made by reversing journals,
 * so a "dry run" that reached one of these writers would create a permanent financial record. Worse, a
 * disbursement driven to `paid` credits the payout clearing account, and the only writer that discharges that
 * account cannot post while the settlement gate is closed — so test traffic alone could leave an
 * undischargeable balance. That is the BC-07 problem, and it is why a dry run must be structurally incapable
 * of reaching these writers rather than merely configured not to.
 */

/**
 * Database writers that create a permanent financial record.
 *
 * Taken from the existing migrations. A dry run or scaffold may not invoke any of them, directly or
 * indirectly, except inside an isolated transaction that is guaranteed to roll back.
 */
export const LIVE_MONEY_WRITERS = Object.freeze([
  'app_private.post_ledger_journal',
  'app_private.reverse_ledger_journal',
  'app_private.fulfil_checkout',
  'app_private.release_seller_holds',
  'app_private.spend_wallet_on_promotion',
  'app_private.request_withdrawal',
  'app_private.transition_withdrawal',
  'app_private.create_payout',
  'app_private.settle_payout',
  'app_private.settle_payout_reversal',
  'app_private.open_settlement',
  'app_private.record_settlement_item',
  'app_private.match_settlement',
  'app_private.reconcile_settlement',
  'app_private.close_settlement',
] as const);

export type LiveMoneyWriter = (typeof LIVE_MONEY_WRITERS)[number];

export function isLiveMoneyWriter(name: string): name is LiveMoneyWriter {
  return (LIVE_MONEY_WRITERS as readonly string[]).includes(name);
}

/** An operation that would move real money was attempted under the provisional baseline. */
export class LiveMoneyBlockedError extends Error {
  readonly operation: string;
  readonly blockingRuleIds: readonly string[];

  constructor(operation: string, blockingRuleIds: readonly string[]) {
    super(
      `${operation} is refused: the compliance review is ${LEGAL_REVIEW_STATUS} and ${blockingRuleIds.length} provisional rules block live money`,
    );
    this.name = 'LiveMoneyBlockedError';
    this.operation = operation;
    this.blockingRuleIds = blockingRuleIds;
  }
}

/**
 * Refuses an operation that would move real money.
 *
 * Throws unconditionally while the baseline is provisional. There is no parameter that suppresses it and no
 * counterpart that permits an operation — permitting one requires the blockers to close, not a call to this
 * module.
 */
export function assertLiveMoneyBlocked(operation: string): never {
  throw new LiveMoneyBlockedError(
    operation,
    rulesBlockingLiveMoney().map((entry) => entry.ruleId),
  );
}

/** Whether real money may move. Always `false` under the provisional baseline. */
export function liveMoneyPermitted(): false {
  return false;
}
