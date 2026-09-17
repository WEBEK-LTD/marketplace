import { Worker, type Job, UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ReadinessResponse } from '@repo/contracts';
import { SpanKind, SpanStatusCode, trace } from '@repo/telemetry';
import type { WorkerEnv } from '../config/env.js';
import { HealthServer } from '../health/health-server.js';
import { errorSummary, type WorkerLogger } from '../logging/logger.js';
import { verifyNoEviction } from '../redis/eviction-policy.js';
import { DeadLetterQueue } from '../queue/dead-letter.js';
import type { QueueDefinition } from '../queue/definitions.js';
import { assertIdPayload } from '../queue/payload.js';
import { assertQueueName, BACKOFF_TYPE, backoffDelay, QUEUE_PREFIX } from '../queue/policy.js';

export interface RuntimeOptions {
  /** Test hooks only. */
  readonly random?: () => number;
  readonly stalledIntervalMs?: number;
  readonly lockDurationMs?: number;
  readonly deadLetterRetentionMs?: number;
  readonly purgeIntervalMs?: number;
}

const PING_TIMEOUT_MS = 1_000;
const FORCED_CLOSE_GRACE_MS = 1_000;
const DEFAULT_PURGE_INTERVAL_MS = 60 * 60 * 1_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Owns the worker lifecycle: health server, Redis readiness and the noeviction check,
 * BullMQ workers with retry and dead-lettering, and graceful shutdown.
 */
export class WorkerRuntime {
  private readonly health: HealthServer;
  private readonly workers: Worker[] = [];
  private readonly deadLetters = new Map<string, DeadLetterQueue>();
  private evictionVerified = false;
  private stopping = false;
  private started = false;
  private purgeTimer: NodeJS.Timeout | undefined;
  private fatalError: Error | undefined;
  private readonly fatalListeners: Array<(error: Error) => void> = [];
  private activeJobs = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly env: WorkerEnv,
    private readonly redis: Redis,
    private readonly definitions: readonly QueueDefinition[],
    private readonly logger: WorkerLogger,
    private readonly options: RuntimeOptions = {},
  ) {
    for (const definition of definitions) {
      assertQueueName(definition.name);
    }
    this.health = new HealthServer(() => this.readiness());
  }

  get healthServer(): HealthServer {
    return this.health;
  }

  async readiness(): Promise<ReadinessResponse> {
    let redisOk = false;
    if (!this.stopping && this.redis.status === 'ready' && this.evictionVerified) {
      try {
        redisOk = (await withTimeout(this.redis.ping(), PING_TIMEOUT_MS)) === 'PONG';
      } catch {
        redisOk = false;
      }
    }
    const workersOk = !this.stopping && this.started && this.workers.every((worker) => worker.isRunning());
    const checks: ReadinessResponse['checks'] = [
      { name: 'redis', status: redisOk ? 'ok' : 'failed' },
      { name: 'workers', status: workersOk ? 'ok' : 'failed' },
    ];
    return { status: redisOk && workersOk ? 'ready' : 'not_ready', checks };
  }

  /** Starts the health server, waits for Redis, verifies noeviction and starts the workers. */
  async start(): Promise<void> {
    const address = await this.health.listen(this.env.health.host, this.env.health.port);
    this.logger.info({ event: 'health_listening', port: address.port }, 'Health server listening');

    this.redis.on('ready', () => {
      if (this.started && !this.stopping) {
        void this.reverifyAfterReconnect();
      }
    });
    this.redis.on('close', () => {
      this.evictionVerified = false;
    });

    await this.waitForRedis();
    if (this.stopping) return;
    const method = await verifyNoEviction(this.redis);
    this.evictionVerified = true;
    this.logger.info({ event: 'eviction_policy_verified', method }, 'Redis maxmemory-policy is noeviction');

    for (const definition of this.definitions) {
      this.startWorker(definition);
    }
    this.started = true;
    await this.purgeDeadLetters();
    this.purgeTimer = setInterval(() => void this.purgeDeadLetters(), this.options.purgeIntervalMs ?? DEFAULT_PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
    this.logger.info({ event: 'worker_started', queues: this.definitions.map((d) => d.name) }, 'Worker started');
  }

  /** Redis may be down at start-up: keep waiting (ioredis reconnects with capped backoff). */
  private async waitForRedis(): Promise<void> {
    if (this.redis.status === 'wait') {
      this.redis.connect().catch(() => undefined);
    }
    while (!this.stopping && this.redis.status !== 'ready') {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.redis.off('ready', done);
          resolve();
        };
        const timer = setTimeout(done, 1_000);
        this.redis.once('ready', done);
      });
    }
  }

  private async reverifyAfterReconnect(): Promise<void> {
    try {
      await verifyNoEviction(this.redis);
      this.evictionVerified = true;
    } catch (error) {
      this.fatalError = error instanceof Error ? error : new Error(String(error));
      this.logger.fatal({ event: 'eviction_policy_failed', ...errorSummary(error) }, 'Redis policy check failed after reconnect');
      for (const listener of this.fatalListeners) listener(this.fatalError);
    }
  }

  /** Called when the worker must stop because a required condition no longer holds. */
  onFatal(listener: (error: Error) => void): void {
    this.fatalListeners.push(listener);
  }

  get fatal(): Error | undefined {
    return this.fatalError;
  }

  private startWorker(definition: QueueDefinition): void {
    const deadLetter = new DeadLetterQueue(
      definition.name,
      this.redis,
      this.logger,
      this.options.deadLetterRetentionMs,
    );
    this.deadLetters.set(definition.name, deadLetter);
    const random = this.options.random ?? Math.random;

    const worker = new Worker(
      definition.name,
      async (job: Job) => {
        this.activeJobs += 1;
        try {
          // Explicit job span (O8-8): new root per job; only queue, job name and attempt are recorded.
          await trace.getTracer('worker').startActiveSpan(
            `process ${definition.name}`,
            {
              kind: SpanKind.CONSUMER,
              root: true,
              attributes: { 'queue.name': definition.name, 'job.name': job.name, 'job.attempt': job.attemptsMade + 1 },
            },
            async (span) => {
              try {
                try {
                  assertIdPayload(job.data);
                } catch (error) {
                  throw new UnrecoverableError((error as Error).name);
                }
                await definition.process({ id: String(job.id), name: job.name, data: job.data });
              } catch (error) {
                span.setAttribute('error.type', errorSummary(error).errorType);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw error;
              } finally {
                span.end();
              }
            },
          );
        } finally {
          this.activeJobs -= 1;
          if (this.activeJobs === 0) {
            for (const wake of this.idleWaiters.splice(0)) wake();
          }
        }
      },
      {
        connection: this.redis,
        prefix: QUEUE_PREFIX,
        concurrency: this.env.concurrency,
        autorun: true,
        ...(this.options.stalledIntervalMs === undefined ? {} : { stalledInterval: this.options.stalledIntervalMs }),
        ...(this.options.lockDurationMs === undefined ? {} : { lockDuration: this.options.lockDurationMs }),
        settings: {
          backoffStrategy: (attemptsMade: number, type?: string) =>
            type === BACKOFF_TYPE ? backoffDelay(attemptsMade, random) : -1,
        },
      },
    );

    worker.on('failed', (job: Job | undefined, error: Error) => {
      if (job === undefined) return;
      const finalFailure = job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError || error.name === 'UnrecoverableError';
      this.logger.warn(
        { event: finalFailure ? 'job_failed_final' : 'job_failed_retrying', queue: definition.name, jobId: job.id, attempts: job.attemptsMade, ...errorSummary(error) },
        'Job failed',
      );
      if (finalFailure) {
        deadLetter.moveToDeadLetter(job, error).catch((dlqError: unknown) => {
          this.logger.error({ event: 'dead_letter_store_failed', queue: definition.name, jobId: job.id, ...errorSummary(dlqError) }, 'Could not store dead-letter entry');
        });
      }
    });
    worker.on('error', (error: Error) => {
      this.logger.warn({ event: 'worker_error', queue: definition.name, ...errorSummary(error) }, 'Worker error');
    });
    this.workers.push(worker);
  }

  private async purgeDeadLetters(): Promise<void> {
    for (const [queue, deadLetter] of this.deadLetters) {
      try {
        const removed = await deadLetter.purgeExpired();
        if (removed > 0) {
          this.logger.info({ event: 'dead_letter_purged', queue, removed }, 'Expired dead-letter entries removed');
        }
      } catch (error) {
        this.logger.warn({ event: 'dead_letter_purge_failed', queue, ...errorSummary(error) }, 'Dead-letter purge failed');
      }
    }
  }

  private whenIdle(): Promise<void> {
    if (this.activeJobs === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async closeRedis(): Promise<void> {
    if (this.redis.status === 'end') return;
    if (this.redis.status !== 'ready') {
      this.redis.disconnect();
      return;
    }
    const ended = new Promise<void>((resolve) => this.redis.once('end', () => resolve()));
    try {
      await withTimeout(this.redis.quit(), 2_000);
    } catch {
      this.redis.disconnect();
    }
    await withTimeout(ended, 2_000).catch(() => this.redis.disconnect());
  }

  /**
   * Graceful shutdown: stop taking jobs, let active jobs finish (up to the timeout),
   * then force-close. Unfinished jobs stay in Redis and are retried later by BullMQ.
   */
  async stop(signal = 'SIGTERM'): Promise<{ timedOut: boolean }> {
    if (this.stopping) return { timedOut: false };
    this.stopping = true;
    if (this.purgeTimer !== undefined) clearInterval(this.purgeTimer);
    this.logger.info({ event: 'shutdown_started', signal }, 'Shutdown started');

    // 1) stop fetching new jobs (no waiting, no reconnect);
    // 2) wait for this process's active jobs, up to the timeout (skipped if Redis is down);
    // 3) close the workers, forcing the close only if jobs are still running. Unfinished jobs
    //    keep their state in Redis and are retried by BullMQ once their locks expire.
    await Promise.all(this.workers.map((worker) => withTimeout(worker.pause(true), 1_000).catch(() => undefined)));
    let timedOut: boolean;
    if (this.redis.status !== 'ready') {
      timedOut = this.activeJobs > 0;
      this.logger.warn({ event: 'shutdown_redis_unavailable', activeJobs: this.activeJobs }, 'Redis unavailable during shutdown');
    } else {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.env.shutdownTimeoutMs);
      });
      timedOut = await Promise.race([this.whenIdle().then(() => false), timeout]);
      clearTimeout(timer);
      if (timedOut) {
        this.logger.warn({ event: 'shutdown_timeout', timeoutMs: this.env.shutdownTimeoutMs, activeJobs: this.activeJobs }, 'Shutdown timeout reached; forcing close');
      }
    }
    const force = timedOut || this.redis.status !== 'ready';
    await Promise.all(
      this.workers.map((worker) => withTimeout(worker.close(force), FORCED_CLOSE_GRACE_MS * 2).catch(() => undefined)),
    );
    this.logger.debug({ event: 'shutdown_stage', stage: 'workers_closed' }, 'Workers closed');
    await Promise.all([...this.deadLetters.values()].map((deadLetter) => deadLetter.close().catch(() => undefined)));
    this.logger.debug({ event: 'shutdown_stage', stage: 'queues_closed' }, 'Queues closed');
    await this.closeRedis();
    this.logger.debug({ event: 'shutdown_stage', stage: 'redis_closed' }, 'Redis closed');
    await this.health.close();
    this.logger.info({ event: 'shutdown_complete', signal, timedOut }, 'Shutdown complete');
    return { timedOut };
  }
}
