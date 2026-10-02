import { errorSummary, type WorkerLogger } from '../logging/logger.js';
import type { QueueDefinition, QueueJob } from '../queue/definitions.js';
import type { OutboxEventHandler } from './outbox-handler.registry.js';
import type { OutboxStore } from './outbox.store.js';

/**
 * The queue a registered outbox handler runs on (Phase 8-A).
 *
 * Steps 3 and 6 of the approved O-10 flow, in one place so that no increment has to reinvent them:
 * "a worker processes it; handler completion is recorded by event id", and "poison jobs move to a
 * dead-letter queue and raise an alert".
 *
 * What this wrapper guarantees, and why each guarantee is here rather than in each handler:
 *
 *   * **Nothing is completed unread.** The job carries `{ eventId }`, so the wrapper reads the event
 *     through 0083's reader first. A row it cannot read is a row it will not settle — the single worst
 *     outcome available to an outbox is recording a business side effect as done when nothing did it.
 *   * **An already-settled event is skipped.** `completed_at` or `dead_lettered_at` already set means
 *     another worker finished this event — a swept event is published again by design — so the handler
 *     does not run a second time and nothing is written. `complete_outbox_event` would no-op anyway;
 *     this simply stops the side effect from being repeated needlessly.
 *   * **Completion follows the handler, never precedes it.** The handler performs its effect and
 *     returns; only then is the event completed. A handler that throws completes nothing, and BullMQ
 *     retries it under the existing policy.
 *   * **Final failure stops the re-publication.** When the attempts are exhausted, the runtime stores
 *     its dead-letter entry and raises the existing structured alert, and this wrapper marks
 *     `dead_lettered_at` so the sweeper stops returning the event to pending. Only the error class is
 *     stored: 0007 constrains `last_error_type` to `^[A-Za-z][A-Za-z0-9_]*$` and its comment says error
 *     messages and stack traces are never stored.
 *
 * 8-A registers no handler, so no instance of this class exists in a running worker. It is the contract
 * the first domain increment builds on, and the tests exercise it with doubles.
 */

/** `last_error_type` accepts a class name and nothing else. Anything unusable becomes this. */
export const UNCLASSIFIED_ERROR_TYPE = 'UnclassifiedError';

const ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Keeps `dead_letter_outbox_event` within 0007's constraint without inventing a taxonomy. */
export function outboxErrorType(value: string): string {
  return ERROR_TYPE.test(value) ? value : UNCLASSIFIED_ERROR_TYPE;
}

export interface OutboxEventOutcome {
  readonly handled: boolean;
  readonly completed: boolean;
  readonly reason?: 'missing' | 'already_settled';
}

export class OutboxEventQueue implements QueueDefinition {
  constructor(
    readonly name: string,
    private readonly handlers: ReadonlyMap<string, OutboxEventHandler>,
    private readonly store: OutboxStore,
    private readonly logger: WorkerLogger,
  ) {}

  async process(job: QueueJob): Promise<void> {
    await this.handle(job);
  }

  async handle(job: QueueJob): Promise<OutboxEventOutcome> {
    const handler = this.handlers.get(job.name);
    if (handler === undefined) {
      // A job whose name no handler owns is not guessed at: it fails, retries, and dead-letters, which
      // also marks the event so the sweeper stops returning it.
      throw new Error(`No outbox handler is registered for job ${job.name} on queue ${this.name}.`);
    }
    const eventId = job.data.eventId;
    if (typeof eventId !== 'string') {
      throw new Error('An outbox job carried no event id.');
    }

    const event = await this.store.read(eventId);
    if (event === null) {
      this.logger.warn({ event: 'outbox_event_missing', queue: this.name }, 'The outbox event could not be read');
      return { handled: false, completed: false, reason: 'missing' };
    }
    if (event.completedAt !== null || event.deadLetteredAt !== null) {
      this.logger.debug(
        { event: 'outbox_event_already_settled', queue: this.name, eventType: event.eventType },
        'The outbox event was already settled',
      );
      return { handled: false, completed: false, reason: 'already_settled' };
    }

    await handler(event);
    const completed = await this.store.complete(eventId);
    return { handled: true, completed };
  }

  async onFinalFailure(job: QueueJob, errorType: string): Promise<void> {
    const eventId = job.data.eventId;
    if (typeof eventId !== 'string') return;
    const type = outboxErrorType(errorType);
    const stopped = await this.store.deadLetter(eventId, type);
    this.logger.error(
      { event: 'outbox_event_dead_lettered', queue: this.name, jobName: job.name, errorType: type, stopped },
      'Outbox event will not be republished',
    );
  }
}

/** Kept for symmetry with the runtime's own summariser; the class name never carries a message. */
export function errorTypeOf(error: unknown): string {
  return outboxErrorType(errorSummary(error).errorType);
}
