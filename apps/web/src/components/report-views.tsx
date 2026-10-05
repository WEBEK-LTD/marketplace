import Link from 'next/link';
import type { ReporterReport } from '@repo/contracts';

/**
 * The reporter's own reports, rendered (Phase 7-M).
 *
 * A server component, so none of this is client code and none of it ships a handler. What it renders is the
 * eight fields the contract carries and nothing else, because there is nothing else: the reader behind it
 * returns no priority, no assignee, no resolution, no resolution note, no resolver, no duplicate-of and not
 * even the subject's id.
 *
 * **The status is shown in the platform's own words.** A reduced reporter-facing vocabulary would be an
 * invented one, and a report whose status said nothing would leave somebody who took the trouble to report
 * something wondering whether it arrived. What is *not* shown is why: a `dismissed` report carries no reason
 * here, because the reason is a moderator's note.
 *
 * **A subject that has left public view keeps its report and loses its link.** That is 0027's own design —
 * "a report survives the subject being removed, which is exactly when it matters most" — so a row with no
 * slug renders as the kind of thing it was and nothing more. It is deliberately *not* rendered as "removed":
 * a listing can leave public view for reasons that have nothing to do with the report, and saying otherwise
 * would be this page inventing an outcome.
 */

export interface ReportHistoryCopy {
  readonly subjectListing: string;
  readonly subjectSeller: string;
  readonly subjectGone: string;
  readonly reasonLabel: string;
  readonly reasons: Readonly<Record<string, string>>;
  readonly statusLabel: string;
  readonly statuses: Readonly<Record<string, string>>;
  readonly filedAt: string;
  readonly yourWords: string;
  readonly view: string;
}

/** A timestamp to the minute, in the value the API sent. No zone arithmetic happens here. */
function minute(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

function Badge({ label }: { readonly label: string }) {
  return (
    <span className="rounded-full border border-neutral-400 px-2 py-0.5 text-xs font-medium text-neutral-800">
      {label}
    </span>
  );
}

/**
 * Where a still-visible subject lives.
 *
 * Built from the slug the reader already has, under the active locale. A row with no slug gets no link, so
 * there is no address composed for something the public cannot see.
 */
function subjectHref(report: ReporterReport, prefix: string): string | null {
  if (report.subjectSlug === null) return null;
  const slug = encodeURIComponent(report.subjectSlug);
  return report.subjectType === 'seller' ? `${prefix}/seller/${slug}` : `${prefix}/listing/${slug}`;
}

export function ReportHistoryList({
  items,
  prefix,
  copy,
}: {
  readonly items: readonly ReporterReport[];
  /** `''` or `'/ar'`. The locale prefix a subject link is built under. */
  readonly prefix: string;
  readonly copy: ReportHistoryCopy;
}) {
  return (
    <ul className="mt-6 space-y-3">
      {items.map((report) => {
        const href = subjectHref(report, prefix);
        const kind = report.subjectType === 'seller' ? copy.subjectSeller : copy.subjectListing;
        return (
          <li key={report.id} className="rounded-lg border border-neutral-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-medium text-neutral-900">
                  {/* The label the reader already saw on the page they reported, or the kind of thing it was. */}
                  {report.subjectLabel ?? copy.subjectGone}
                </p>
                <p className="mt-1 text-xs text-neutral-600">{kind}</p>
              </div>
              <Badge label={copy.statuses[report.status] ?? report.status} />
            </div>

            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
              <div>
                <dt className="text-xs text-neutral-600">{copy.reasonLabel}</dt>
                <dd className="text-neutral-900">{copy.reasons[report.reasonCode] ?? report.reasonCode}</dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-600">{copy.filedAt}</dt>
                <dd className="text-neutral-900">{minute(report.createdAt)}</dd>
              </div>
            </dl>

            {report.details !== null && (
              <div className="mt-3">
                <p className="text-xs text-neutral-600">{copy.yourWords}</p>
                <p className="mt-1 max-w-prose whitespace-pre-line text-sm text-neutral-900">
                  {report.details}
                </p>
              </div>
            )}

            {href !== null && (
              <p className="mt-3 text-sm">
                <Link href={href} className="underline underline-offset-4">
                  {copy.view}
                </Link>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
