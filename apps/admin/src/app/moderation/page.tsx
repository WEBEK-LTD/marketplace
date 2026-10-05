import { redirect } from 'next/navigation';

/**
 * The `/moderation` console section's home (Phase 7-F, given its tools in 7-N).
 *
 * 7-F's navigation entry points here and 7-N gives the section two screens, so this address is the section's
 * front door rather than a screen of its own: it sends a colleague to the report queue, which is what the
 * section is for. A redirect rather than a second copy of the queue, because two addresses rendering the same
 * page is two pages to keep in step — and rather than moving the navigation entry, because a bookmark to
 * `/moderation` should keep working.
 *
 * It reads nothing and gates nothing: there is no data here to protect, and the page it sends a colleague to
 * gates itself inside its own body.
 */
export default function Page() {
  redirect('/moderation/reports');
}
