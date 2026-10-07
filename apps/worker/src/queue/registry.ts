import type { WorkerEnv } from '../config/env.js';
import { EmailDeliveryQueue } from '../email/email-delivery.queue.js';
import { AppWorkerStore } from '../email/email-outbox.store.js';
import {
  LISTING_EVENT_DRAIN_INTERVAL_MS,
  ListingEventConsumerQueue,
} from '../analytics/listing-events.consumer.js';
import { AppWorkerListingEventStore } from '../analytics/listing-events.store.js';
import { createRedisConnection } from '../redis/connection.js';
import type { EmailTransport } from '../email/email-transport.js';
import type { WorkerLogger } from '../logging/logger.js';
import { OutboxEventQueue } from '../outbox/outbox-event.queue.js';
import { OutboxHandlerRegistry } from '../outbox/outbox-handler.registry.js';
import { OutboxRelayQueue } from '../outbox/outbox-relay.queue.js';
import { OutboxSweeperQueue } from '../outbox/outbox-sweeper.queue.js';
import { AppWorkerOutboxStore, type OutboxStore } from '../outbox/outbox.store.js';
import type { QueueDefinition } from './definitions.js';

/**
 * Which queues this worker runs.
 *
 * Two independent decisions, and both of them are the same decision: **do not register infrastructure
 * for a capability whose implementation does not exist yet.**
 *
 * * **Email (Phase 7-D).** v5.2 records the email provider as "SMTP-compatible provider behind a mail
 *   adapter — Provider pending (value)", and 7-D chooses none: with no transport the email relay is not
 *   registered. Nothing is claimed, no row leaves `queued`, and no message spends an attempt against a
 *   transport that cannot carry it.
 *
 * * **The transactional outbox (Phase 8-A).** The handler registry is empty and stays empty in 8-A: no
 *   event type in this repository has an authoritative handler, and a relay that published events
 *   nobody processes would either complete them falsely or have them swept in a loop until the whole
 *   outbox dead-lettered. So with an empty registry the relay and the sweeper are **not registered**,
 *   and every committed event waits, untouched and pending, for the increment that owns it.
 *
 * When a domain increment registers its first handler, this function builds three things: the relay,
 * the sweeper, and one `OutboxEventQueue` per distinct destination queue. Nothing else changes.
 */
export function buildQueueDefinitions(
  env: WorkerEnv,
  logger: WorkerLogger,
  transport: EmailTransport | null = null,
  outboxHandlers: OutboxHandlerRegistry = OutboxHandlerRegistry.EMPTY,
  outboxStore: OutboxStore | null = null,
): readonly QueueDefinition[] {
  const definitions: QueueDefinition[] = [];

  if (transport === null) {
    logger.info(
      { event: 'email_relay_not_registered' },
      'No email transport is configured; the email outbox relay is not running',
    );
  } else {
    const store = AppWorkerStore.fromConnectionString(env.appWorkerDatabaseUrl, env.appWorkerDatabaseMaxConnections);
    definitions.push(new EmailDeliveryQueue(store, transport, logger, env.emailRelayIntervalMs));
  }

  // 0101. Registered before the outbox early-return below, because ingestion does not depend on an outbox
  // handler being present: a deployment that relays no events still collects them.
  definitions.push(
    new ListingEventConsumerQueue(
      createRedisConnection(env.redisUrl, logger),
      AppWorkerListingEventStore.fromConnectionString(
        env.appWorkerDatabaseUrl,
        env.appWorkerDatabaseMaxConnections,
      ),
      logger,
      LISTING_EVENT_DRAIN_INTERVAL_MS,
    ),
  );

  if (outboxHandlers.isEmpty) {
    logger.info(
      { event: 'outbox_relay_not_registered' },
      'No outbox handler is registered; the outbox relay and sweeper are not running',
    );
    return definitions;
  }

  const store =
    outboxStore ??
    AppWorkerOutboxStore.fromConnectionString(env.appWorkerDatabaseUrl, env.appWorkerDatabaseMaxConnections);
  definitions.push(
    new OutboxRelayQueue(store, outboxHandlers, logger, env.outboxRelayIntervalMs),
    new OutboxSweeperQueue(store, logger, env.outboxSweeperIntervalMs),
  );
  for (const queue of outboxHandlers.queues) {
    definitions.push(new OutboxEventQueue(queue, outboxHandlers.handlersFor(queue), store, logger));
  }
  return definitions;
}
