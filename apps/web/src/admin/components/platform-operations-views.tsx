import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  JobRunDetail,
  JobRunPageResponse,
  OutboxResponse,
  ScheduleProblemsResponse,
  ScheduledJobCatalogueResponse,
} from '@repo/contracts';
import {
  readJobRun,
  readJobRuns,
  readOutbox,
  readScheduleProblems,
  readScheduledJobs,
  type PlatformOperationsResult,
} from '../server/bff';
import { currentCookieHeader } from '../server/current-staff';
import { adminPath } from '../paths';

/**
 * The platform operations screens (Phase 7-Q).
 *
 * **Every one is a server component rendered *inside* `RequireStaff`.** That placement is the whole of the RSC
 * protection: a gate that refuses never invokes `children`, so a subtree a colleague may not see is never
 * rendered, never serialized and never streamed. Nothing here is hidden with CSS and nothing is filtered in
 * the browser.
 *
 * **They fetch nothing until they render**, because the reads live in the gated subtree rather than in the page
 * function — so a refused request performs no read at all. That matters more here than on most sections:
 * `platform.job.read` is held by Admin and Super Admin alone, so most of the console's users are refused.
 *
 * ---------------------------------------------------------------------------------------------------
 * **THERE IS NO CONTROL IN THIS FILE, AND NO CLIENT COMPONENT BESIDE IT.**
 *
 * No retry, no cancel, no requeue, no re-run, no dead-letter replay — no button of any kind. The workers own
 * every write to a job run and to an outbox event, and this repository has no writer for any of those actions,
 * so a control here would post to a route that does not exist and could not be built without an owner decision
 * first. The pages say so in words rather than leaving somebody hunting for a button.
 * ---------------------------------------------------------------------------------------------------
 *
 * **Two standing facts are stated on the page, not inferred from the numbers.** No outbox relay and no sweeper
 * exist in this repository yet, so every event stays pending and the pending count only grows — accurate, and
 * badly misleading if left unexplained, because it looks exactly like a relay that has fallen over. And the
 * worker's repeatable jobs record no run, so the schedule below is the database's jobs only. Both are written
 * into the copy beside the figures.
 *
 * **No verdict is rendered.** Ages are shown as ages and counts as counts; nothing here colours a number red
 * or calls it late, because the platform's own sweeper takes its staleness threshold from its caller and this
 * console does not get to pick one.
 *
 * **The raw failure text is absent, and the page says that too.** A failed run shows its error class and
 * SQLSTATE; the message the job runner stored is a raw database error that quotes the row which caused it, so
 * it is not carried here at all. A screen that silently showed less than it had would send somebody looking
 * for a bug.
 *
 * **Every state is a state, not an absence.** Empty list, unreadable answer, ended session, a caller without
 * the key, a job that has never run, and a schedule with nothing wrong with it each have their own rendering.
 */

type Translate = Awaited<ReturnType<typeof getTranslations<'Platform'>>>;

/** A timestamp shown to the minute, in the value the API sent. No zone arithmetic happens here. */
function minute(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

async function refusal(
  result: PlatformOperationsResult<unknown>,
  t: Translate,
): Promise<React.ReactElement | null> {
  if (result.kind === 'ok') return null;
  const shell = await getTranslations('Console');
  if (result.kind === 'unauthenticated') {
    return <Notice title={shell('signedOutTitle')} body={shell('signedOutBody')} />;
  }
  if (result.kind === 'notFound') return <Notice title={t('notFoundTitle')} body={t('notFoundBody')} />;
  if (result.kind === 'invalid') return <Notice title={t('cursorTitle')} body={t('cursorBody')} />;
  return <Notice title={shell('unavailableTitle')} body={shell('unavailableBody')} />;
}

function Notice({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="mt-8 rounded-lg border border-neutral-200 p-6" role="status">
      <p className="text-base font-medium text-neutral-900">{title}</p>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{body}</p>
    </div>
  );
}

function Cell({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-600">{label}</dt>
      <dd className="text-neutral-900">{value}</dd>
    </div>
  );
}

function Badge({ label }: { readonly label: string }) {
  return (
    <span className="rounded-full border border-neutral-400 px-2 py-0.5 text-xs font-medium text-neutral-800">
      {label}
    </span>
  );
}

function NextPage({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <p className="mt-6 text-sm">
      <Link href={href} className="underline underline-offset-4">
        {label}
      </Link>
    </p>
  );
}

/** A count, shown as a plain number. `toLocaleString` is deliberately avoided: the locale is not the server's. */
function count(value: number): string {
  return String(value);
}

/** A duration, in the unit that suits its size. A fact about one run, never a judgement about it. */
function duration(ms: number | null, t: Translate): string {
  if (ms === null) return t('stillRunning');
  if (ms < 1000) return t('durationMs', { value: ms });
  return t('durationSeconds', { value: Math.round(ms / 100) / 10 });
}

/* ------------------------------------------------------------------------------------------------ */
/* The schedule                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export async function ScheduledJobs() {
  const t = await getTranslations('Platform');
  const result = await readScheduledJobs({ cookieHeader: await currentCookieHeader() });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const { items } = (result as { kind: 'ok'; data: ScheduledJobCatalogueResponse }).data;

  return (
    <section aria-labelledby="scheduled-jobs" className="mt-10">
      <h2 id="scheduled-jobs" className="text-lg font-medium text-neutral-900">
        {t('scheduleHeading')}
      </h2>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('scheduleIntro')}</p>
      {/*
        The reported gap, on the page: the worker's repeatable jobs record no run, so this list is the
        database's scheduled jobs and nothing else. Said here rather than left to be noticed as an absence.
      */}
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('workerJobsNote')}</p>

      {items.length === 0 ? (
        <Notice title={t('scheduleEmptyTitle')} body={t('scheduleEmptyBody')} />
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((job) => (
            <li key={job.jobKey} className="rounded-lg border border-neutral-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-base font-medium text-neutral-900">
                    <Link
                      href={adminPath(`/platform/jobs?jobName=${encodeURIComponent(job.jobKey)}`)}
                      className="underline underline-offset-4"
                    >
                      {job.jobKey}
                    </Link>
                  </p>
                  <p className="mt-1 max-w-prose text-sm text-neutral-600">{job.purpose}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge label={job.cronSchedule} />
                  {job.lastStatus !== null && <Badge label={t(`status.${job.lastStatus}`)} />}
                </div>
              </div>

              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
                <Cell label={t('targetLabel')} value={job.targetSignature} />
                <Cell label={t('runCountLabel')} value={count(job.runCount)} />
                <Cell label={t('failureCountLabel')} value={count(job.failureCount)} />
                {/*
                  Nulls together: a contracted job that has never run reports nothing rather than zeros,
                  because nothing having run is a different fact from something running and processing nothing.
                */}
                {job.lastStartedAt === null ? (
                  <Cell label={t('lastRunLabel')} value={t('neverRun')} />
                ) : (
                  <>
                    <Cell label={t('lastRunLabel')} value={minute(job.lastStartedAt)} />
                    <Cell label={t('lastDurationLabel')} value={duration(job.lastDurationMs, t)} />
                    {job.lastProcessedCount !== null && (
                      <Cell
                        label={t('processedLabel')}
                        value={count(job.lastProcessedCount)}
                      />
                    )}
                    {job.lastErrorType !== null && (
                      <Cell label={t('errorClassLabel')} value={job.lastErrorType} />
                    )}
                  </>
                )}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Schedule drift                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Where the real schedule and the contract disagree.
 *
 * An empty list is the good answer and gets a sentence saying so, because a heading with nothing under it
 * would read as a panel that failed to load. A refusal renders nothing at all.
 */
export async function ScheduleProblems() {
  const t = await getTranslations('Platform');
  const result = await readScheduleProblems({ cookieHeader: await currentCookieHeader() });
  if (result.kind !== 'ok') return null;
  const { items } = (result as { kind: 'ok'; data: ScheduleProblemsResponse }).data;

  return (
    <section aria-labelledby="schedule-problems" className="mt-10">
      <h2 id="schedule-problems" className="text-lg font-medium text-neutral-900">
        {t('problemsHeading')}
      </h2>
      {items.length === 0 ? (
        <p role="status" className="mt-2 max-w-prose text-sm text-neutral-600">
          {t('problemsNone')}
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {items.map((problem) => (
            <li
              key={`${problem.object}:${problem.problem}`}
              className="rounded-lg border border-neutral-300 p-4 text-sm"
            >
              <p className="font-medium text-neutral-900">{problem.object}</p>
              {/* The guard's own sentence, not translated: it is a database fact rather than console copy. */}
              <p className="mt-1 max-w-prose text-neutral-700">{problem.problem}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Outbox health                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export async function OutboxPanel() {
  const t = await getTranslations('Platform');
  const result = await readOutbox({ cookieHeader: await currentCookieHeader() });
  if (result.kind !== 'ok') return null;
  const { health, items } = (result as { kind: 'ok'; data: OutboxResponse }).data;

  return (
    <section aria-labelledby="outbox" className="mt-10">
      <h2 id="outbox" className="text-lg font-medium text-neutral-900">
        {t('outboxHeading')}
      </h2>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('outboxIntro')}</p>
      {/*
        The other reported gap, and the one that would mislead most. No relay and no sweeper exist in this
        repository, so every event stays pending and the count only grows: the numbers below are correct and
        look exactly like a relay that has fallen over. Said before the figures rather than after them.
      */}
      <p role="status" className="mt-2 max-w-prose text-sm text-neutral-600">
        {t('noRelayNote')}
      </p>

      <dl
        aria-label={t('outboxCounts')}
        className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3"
      >
        <Cell label={t('pendingLabel')} value={count(health.pendingCount)} />
        <Cell label={t('dueLabel')} value={count(health.dueCount)} />
        <Cell label={t('inFlightLabel')} value={count(health.inFlightCount)} />
        <Cell label={t('completedLabel')} value={count(health.completedCount)} />
        <Cell label={t('deadLetteredLabel')} value={count(health.deadLetteredCount)} />
        {health.maxAttempts !== null && (
          <Cell label={t('maxAttemptsLabel')} value={count(health.maxAttempts)} />
        )}
        {/* Ages, as ages. Nothing here calls one of them late. */}
        {health.oldestPendingAt !== null && (
          <Cell label={t('oldestPendingLabel')} value={minute(health.oldestPendingAt)} />
        )}
        {health.oldestInFlightAt !== null && (
          <Cell label={t('oldestInFlightLabel')} value={minute(health.oldestInFlightAt)} />
        )}
        {health.latestDeadLetteredAt !== null && (
          <Cell label={t('latestDeadLetteredLabel')} value={minute(health.latestDeadLetteredAt)} />
        )}
      </dl>

      <h3 className="mt-6 text-base font-medium text-neutral-900">{t('deadLettersHeading')}</h3>
      {items.length === 0 ? (
        <p role="status" className="mt-2 max-w-prose text-sm text-neutral-600">
          {t('deadLettersNone')}
        </p>
      ) : (
        <>
          {/*
            Grouped rather than listed, and the page says why: identifying each event would mean naming the
            order, conversation or account it is about, and there is no action here to take on one.
          */}
          <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('deadLettersGroupedNote')}</p>
          <ul className="mt-4 space-y-3">
            {items.map((group) => (
              <li
                key={`${group.eventType}:${group.lastErrorType ?? ''}`}
                className="rounded-lg border border-neutral-200 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-base font-medium text-neutral-900">{group.eventType}</p>
                  <div className="flex flex-wrap gap-2">
                    {group.lastErrorType !== null && <Badge label={group.lastErrorType} />}
                    <Badge label={t('eventCountBadge', { value: group.eventCount })} />
                  </div>
                </div>
                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
                  <Cell label={t('firstDeadLetteredLabel')} value={minute(group.firstDeadLetteredAt)} />
                  <Cell label={t('lastDeadLetteredLabel')} value={minute(group.lastDeadLetteredAt)} />
                  <Cell label={t('maxAttemptsLabel')} value={count(group.maxAttempts)} />
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* No control, and the reason, rather than leaving somebody hunting for a replay button. */}
      <p className="mt-6 max-w-prose text-sm text-neutral-600">{t('readOnlyNote')}</p>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The runs                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export async function JobRunList({
  cursor,
  status,
  jobName,
}: {
  readonly cursor: string | null;
  readonly status: string | null;
  readonly jobName: string | null;
}) {
  const t = await getTranslations('Platform');
  const result = await readJobRuns(
    { cursor, status, jobName },
    { cookieHeader: await currentCookieHeader() },
  );

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const page = (result as { kind: 'ok'; data: JobRunPageResponse }).data;

  const filters = [
    status === null ? '' : `&status=${encodeURIComponent(status)}`,
    jobName === null ? '' : `&jobName=${encodeURIComponent(jobName)}`,
  ].join('');

  return (
    <section aria-labelledby="job-runs" className="mt-10">
      <h2 id="job-runs" className="text-lg font-medium text-neutral-900">
        {t('runsHeading')}
      </h2>
      <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('runsIntro')}</p>
      {jobName !== null && (
        <p className="mt-2 text-sm text-neutral-600">
          {t('filteredByJob', { jobName })}{' '}
          <Link href={adminPath('/platform/jobs')} className="underline underline-offset-4">
            {t('clearFilter')}
          </Link>
        </p>
      )}

      {page.items.length === 0 ? (
        <Notice title={t('runsEmptyTitle')} body={t('runsEmptyBody')} />
      ) : (
        <>
          <ul className="mt-4 space-y-3">
            {page.items.map((run) => (
              <li key={run.id} className="rounded-lg border border-neutral-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-medium text-neutral-900">
                      <Link
                        href={adminPath(`/platform/jobs/${run.id}`)}
                        className="underline underline-offset-4"
                      >
                        {run.jobName}
                      </Link>
                    </p>
                    <p className="mt-1 text-sm text-neutral-600">{minute(run.startedAt)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge label={t(`status.${run.status}`)} />
                    {run.errorType !== null && <Badge label={run.errorType} />}
                    {/* A run of a key the schedule has dropped is labelled, not hidden. */}
                    {!run.isContracted && <Badge label={t('uncontractedBadge')} />}
                  </div>
                </div>

                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
                  <Cell label={t('durationLabel')} value={duration(run.durationMs, t)} />
                  <Cell
                    label={t('processedLabel')}
                    value={run.processedCount === null ? t('notRecorded') : count(run.processedCount)}
                  />
                  {run.scheduledFor !== null && (
                    <Cell label={t('scheduledForLabel')} value={minute(run.scheduledFor)} />
                  )}
                </dl>
              </li>
            ))}
          </ul>
          {page.nextCursor !== null && (
            <NextPage
              href={adminPath(`/platform/jobs?cursor=${encodeURIComponent(page.nextCursor)}${filters}`)}
              label={t('nextPage')}
            />
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* One run                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export async function JobRunDetailView({ runId }: { readonly runId: string }) {
  const t = await getTranslations('Platform');
  const result = await readJobRun(runId, { cookieHeader: await currentCookieHeader() });

  const failed = await refusal(result, t);
  if (failed !== null) return failed;
  const run = (result as { kind: 'ok'; data: JobRunDetail }).data;

  return (
    <section aria-labelledby="run-name" className="mt-6">
      <h2 id="run-name" className="text-lg font-medium text-neutral-900">
        {run.jobName}
      </h2>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge label={t(`status.${run.status}`)} />
        {run.isContracted ? null : <Badge label={t('uncontractedBadge')} />}
      </div>

      <dl aria-label={t('runFacts')} className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Cell label={t('startedLabel')} value={minute(run.startedAt)} />
        <Cell
          label={t('finishedLabel')}
          value={run.finishedAt === null ? t('stillRunning') : minute(run.finishedAt)}
        />
        <Cell label={t('durationLabel')} value={duration(run.durationMs, t)} />
        <Cell
          label={t('processedLabel')}
          value={run.processedCount === null ? t('notRecorded') : count(run.processedCount)}
        />
        {run.scheduledFor !== null && (
          <Cell label={t('scheduledForLabel')} value={minute(run.scheduledFor)} />
        )}
      </dl>

      {/*
        A failure, as far as this console carries one: the error class and the five-character SQLSTATE. The
        message the job runner stored is a raw database error that quotes the row which caused it, so it is not
        carried at all — and the page says so, because a screen showing less than it had would send somebody
        looking for a bug.
      */}
      {(run.errorType !== null || run.errorSqlstate !== null) && (
        <div className="mt-4 rounded-lg border border-neutral-300 p-4">
          <p className="text-base font-medium text-neutral-900">{t('failureHeading')}</p>
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
            {run.errorType !== null && (
              <Cell label={t('errorClassLabel')} value={run.errorType} />
            )}
            {run.errorSqlstate !== null && (
              <Cell label={t('sqlstateLabel')} value={run.errorSqlstate} />
            )}
          </dl>
          <p className="mt-3 max-w-prose text-sm text-neutral-600">{t('noMessageNote')}</p>
        </div>
      )}

      {/* The contract row, when the schedule still names this key. */}
      {run.isContracted ? (
        <div className="mt-4 rounded-lg border border-neutral-200 p-4">
          <p className="text-base font-medium text-neutral-900">{t('contractHeading')}</p>
          <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
            {run.cronSchedule !== null && (
              <Cell label={t('scheduleLabel')} value={run.cronSchedule} />
            )}
            {run.targetSignature !== null && (
              <Cell label={t('targetLabel')} value={run.targetSignature} />
            )}
          </dl>
          {run.purpose !== null && (
            <p className="mt-3 max-w-prose text-sm text-neutral-700">{run.purpose}</p>
          )}
        </div>
      ) : (
        <p role="status" className="mt-4 max-w-prose text-sm text-neutral-600">
          {t('uncontractedNote')}
        </p>
      )}

      <p className="mt-6 text-sm">
        <Link href={adminPath('/platform/jobs')} className="underline underline-offset-4">
          {t('backToRuns')}
        </Link>
      </p>

      {/* No control, and the reason. */}
      <p className="mt-6 max-w-prose text-sm text-neutral-600">{t('readOnlyNote')}</p>
    </section>
  );
}
