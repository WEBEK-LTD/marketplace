import { errorSummary, type WorkerLogger } from '../logging/logger.js';
import type { QueueDefinition, QueueJob, QueuePublisher, QueueSchedule } from '../queue/definitions.js';
import type { IdPayload } from '../queue/payload.js';
import type { OutboxHandlerRegistry } from './outbox-handler.registry.js';
import type { OutboxStore } from './outbox.store.js';
import { recordScheduledRun } from './scheduled-run.js';

/**
 * The transactional outbox relay (Phase 8-A).
 *
 * Step 2 of the approved O-10 flow: "the relay publishes it to BullMQ". Steps 1 and 3 belong elsewhere
 * — the business transaction commits the event, and the handler records completion by event id — and
 * this file does neither.
 *
 * **The relay claims only what a handler exists for.** The registry's event types travel with the claim
 * (0083's `claim_outbox_events_for`), so an event nobody can process is never claimed, never published,
 * never completed, and — because the sweeper only sees events whose `published_at` is set — never swept
 * either. It simply waits, pending, until the increment that owns it registers its handler. With the
 * empty registry 8-A ships, this queue is not registered at all and the relay never runs.
 *
 * **The job carries the event id and nothing else.** Queue payloads are identifiers only, and
 * `outbox_events.aggregate_id` is `text` — literally `'batch'` for four of the event types already in
 * the schema — so it cannot travel in a payload the runtime will accept. The handler reads its event
 * back through 0083's reader, which is also what lets the wrapper refuse to complete an event it could
 * not read.
 *
 * **No job id is set on the published job.** A deterministic job id would look like extra safety and
 * would in fact break the sweeper: BullMQ refuses to add a job whose id already exists, so a swept
 * event's re-publication would be silently dropped for as long as the first job stayed in Redis.
 * Duplicate publication is safe by design — `complete_outbox_event` is a no-op the second time, and
 * spec step 4 requires idempotent handlers — so the guarantee lives where it can be enforced.
 *
 * **Redis can disappear without losing financial truth.** A failed publish leaves the event with
 * `published_at` set and no completion, which is exactly the state the sweeper returns to pending after
 * five minutes. The committed PostgreSQL row is the source of truth throughout; nothing is lost, and
 * nothing is invented to make up for the loss.
 */

/** Queue name. Lower-case and hyphenated, per `assertQueueName`. Infrastructure, not a business queue. */
export const OUTBOX_RELAY_QUEUE = 'outbox-relay';
export const OUTBOX_RELAY_JOB = 'relay';
export const OUTBOX_RELAY_SCHEDULER_ID = 'outbox-relay';

/** `job_runs.job_name`, per 0007's `^[a-z][a-z0-9_.]*$`. */
export const OUTBOX_RELAY_JOB_NAME = 'outbox.relay';

/**
 * The relay's own identity in its job payload.
 *
 * A relay tick is not a business entity, and `assertIdPayload` admits only `<name>Id` keys with UUID
 * values. Deliberately not `userId`: the runtime reads that key to scope log identity, and a batch
 * belongs to no one person.
 */
export const OUTBOX_RELAY_ID = '8a000000-0000-4000-8000-000000000001';
export const OUTBOX_RELAY_PAYLOAD: IdPayload = Object.freeze({ relayId: OUTBOX_RELAY_ID });

/**
 * How many events one tick claims.
 *
 * `claim_outbox_events_for`'s own default, which is 0007's default for the unfiltered claim. The
 * function refuses anything outside 1–1000.
 */
export const OUTBOX_CLAIM_BATCH_SIZE = 100;

export interface OutboxRelayResult {
  readonly claimed: number;
  readonly published: number;
  /** Claimed events whose publish failed. They stay in flight until the sweeper returns them. */
  readonly failed: number;
}

export class OutboxRelayQueue implements QueueDefinition {
  readonly name = OUTBOX_RELAY_QUEUE;
  readonly schedule: QueueSchedule;
  private publisher: QueuePublisher | null = null;

  constructor(
    private readonly store: OutboxStore,
    private readonly registry: OutboxHandlerRegistry,
    private readonly logger: WorkerLogger,
    intervalMs: number,
    private readonly batchSize: number = OUTBOX_CLAIM_BATCH_SIZE,
  ) {
    this.schedule = {
      jobName: OUTBOX_RELAY_JOB,
      schedulerId: OUTBOX_RELAY_SCHEDULER_ID,
      everyMs: intervalMs,
      data: OUTBOX_RELAY_PAYLOAD,
    };
  }

  attach(publisher: QueuePublisher): void {
    this.publisher = publisher;
  }

  async process(job: QueueJob): Promise<void> {
    await recordScheduledRun(
      this.store,
      OUTBOX_RELAY_JOB_NAME,
      job.scheduledFor,
      this.logger,
      (result: OutboxRelayResult) => result.published,
      () => this.drain(),
    );
  }

  /**
   * One tick.
   *
   * A store error propagates: the job fails and BullMQ retries it under the policy in
   * `queue/policy.ts`. That is the right outcome — an unreachable database is a condition of the tick,
   * not of any one event — and it costs no event its own attempts, which are counted by the claim and
   * by nothing else.
   */
  async drain(): Promise<OutboxRelayResult> {
    const eventTypes = this.registry.eventTypes;
    // Defence in depth: 0083 refuses an empty list, and the queue is not registered without handlers.
    if (eventTypes.length === 0) return { claimed: 0, published: 0, failed: 0 };
    const publisher = this.publisher;
    if (publisher === null) throw new Error('The outbox relay was not attached to a publisher.');

    const claimed = await this.store.claimForEventTypes(eventTypes, this.batchSize);
    let published = 0;
    let failed = 0;

    for (const event of claimed) {
      const registration = this.registry.find(event.eventType);
      if (registration === undefined) {
        // Unreachable through the claim, which filters on exactly these types. Counted, never guessed
        // at: an event with no handler is not completed, not dead-lettered and not routed anywhere.
        failed += 1;
        this.logger.warn(
          { event: 'outbox_relay_unregistered_event', eventType: event.eventType },
          'A claimed event has no registered handler',
        );
        continue;
      }
      try {
        await publisher.publish(registration.queue, registration.jobName, { eventId: event.id });
        published += 1;
      } catch (error) {
        failed += 1;
        // The event keeps published_at with no completion; the sweeper returns it after the threshold.
        this.logger.warn(
          { event: 'outbox_relay_publish_failed', queue: registration.queue, ...errorSummary(error) },
          'Could not publish a claimed outbox event',
        );
      }
    }

    if (claimed.length > 0) {
      // Counts only. No payload, no aggregate id, no person.
      this.logger.info(
        { event: 'outbox_relay_tick', claimed: claimed.length, published, failed },
        'Outbox relay tick',
      );
    }
    return { claimed: claimed.length, published, failed };
  }
}
