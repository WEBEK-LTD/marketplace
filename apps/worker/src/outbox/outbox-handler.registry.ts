import { assertQueueName } from '../queue/policy.js';

/**
 * The outbox handler registration contract (Phase 8-A).
 *
 * This is the whole of it. A registration says three things and holds one function:
 *
 *   * **which event type** it handles — the exact `outbox_events.event_type` string, never a prefix,
 *     never a pattern. 0007 constrains the column to `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` and this
 *     file applies the same expression, so a registration cannot name something the column cannot hold;
 *   * **which queue** its job is published to, and **under which job name** — declared by the increment
 *     that owns the handler, because that increment owns the queue. 8-A maps no event type to any queue
 *     and names no business queue;
 *   * **what to do** with the event, as a function.
 *
 * The registry is the code. There is no registry table, no lookup row and no second source of truth: a
 * handler exists exactly when a function exists, which is the only definition that cannot drift.
 *
 * **In 8-A the registry is empty.** `EMPTY` is what the worker is built with, and an empty registry
 * claims nothing, publishes nothing, completes nothing and dead-letters nothing — the relay and sweeper
 * are not even registered as queues. That is the same answer 7-D gave to the same shape of problem: with
 * no email transport decided, it registers no email queue rather than running one that cannot deliver.
 *
 * Future domain increments add their registrations when their authoritative business behaviour exists.
 */

/** The event-type expression from 0007's `outbox_events_event_type_format`. */
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Job names follow the queue-name rule: lower-case, hyphenated, no surprises in a Redis key. */
const JOB_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** One outbox event, as the worker sees it. Mirrors `app_private.outbox_event_for_worker`. */
export interface OutboxEventView {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
  /** Attempts **including the claim that produced this job**: the claim increments the counter. */
  readonly attempts: number;
  readonly publishedAt: Date | null;
  readonly completedAt: Date | null;
  readonly deadLetteredAt: Date | null;
}

/**
 * What a handler does with one event.
 *
 * It performs the business side effect and returns. It does **not** record completion: the wrapper does
 * that, once, after the handler returns — so no handler can complete an event whose effect it did not
 * perform, and no two increments can invent two different completion conventions.
 *
 * A handler must be idempotent. A swept event is published again, so the same event can reach the same
 * handler twice; spec step 4 says the same thing of every queue job in this system.
 */
export type OutboxEventHandler = (event: OutboxEventView) => Promise<void>;

export interface OutboxHandlerRegistration {
  /** Exact `outbox_events.event_type`. */
  readonly eventType: string;
  /** The BullMQ queue this event's job is published to, owned by the registering increment. */
  readonly queue: string;
  /** The job name within that queue. */
  readonly jobName: string;
  readonly handle: OutboxEventHandler;
}

export class InvalidOutboxHandlerError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutboxHandlerError';
  }
}

/**
 * The set of registered handlers.
 *
 * Validated once, at construction, so a malformed registration fails the worker at start-up rather than
 * at the first event. Everything it exposes is derived and deterministic.
 */
export class OutboxHandlerRegistry {
  /** The registry Phase 8-A ships with. Nothing is registered, so nothing is claimed. */
  static readonly EMPTY = new OutboxHandlerRegistry([]);

  private readonly byEventType: ReadonlyMap<string, OutboxHandlerRegistration>;

  constructor(registrations: readonly OutboxHandlerRegistration[]) {
    const map = new Map<string, OutboxHandlerRegistration>();
    for (const registration of registrations) {
      if (!EVENT_TYPE.test(registration.eventType)) {
        throw new InvalidOutboxHandlerError('An outbox handler must name a valid event type.');
      }
      if (map.has(registration.eventType)) {
        throw new InvalidOutboxHandlerError('An event type may have at most one handler.');
      }
      // Throws TypeError on a name Redis should never see, and on a dead-letter suffix.
      assertQueueName(registration.queue);
      if (!JOB_NAME.test(registration.jobName)) {
        throw new InvalidOutboxHandlerError('An outbox handler must name a valid job name.');
      }
      if (typeof registration.handle !== 'function') {
        throw new InvalidOutboxHandlerError('An outbox handler must be a function.');
      }
      map.set(registration.eventType, registration);
    }
    this.byEventType = map;
  }

  get isEmpty(): boolean {
    return this.byEventType.size === 0;
  }

  /** Sorted, so the argument passed to the claim is the same on every tick and in every test. */
  get eventTypes(): readonly string[] {
    return [...this.byEventType.keys()].sort();
  }

  /** The distinct queues these handlers use, sorted. One `OutboxEventQueue` is built per entry. */
  get queues(): readonly string[] {
    return [...new Set([...this.byEventType.values()].map((r) => r.queue))].sort();
  }

  find(eventType: string): OutboxHandlerRegistration | undefined {
    return this.byEventType.get(eventType);
  }

  /** The registrations that publish to one queue, keyed by job name. */
  handlersFor(queue: string): ReadonlyMap<string, OutboxEventHandler> {
    const handlers = new Map<string, OutboxEventHandler>();
    for (const registration of this.byEventType.values()) {
      if (registration.queue === queue) handlers.set(registration.jobName, registration.handle);
    }
    return handlers;
  }
}
