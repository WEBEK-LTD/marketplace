import { SEARCH_MIN_QUERY_LENGTH } from '@repo/contracts';
import { Button, Input, cx } from '@repo/ui';

export interface SiteSearchFormProps {
  /** `/search` or `/ar/search`, so the form posts to the reader's own language. */
  readonly action: string;
  readonly placeholder: string;
  readonly submitLabel: string;
  /** The current query, when this form is rendered on a page that already searched. */
  readonly defaultValue?: string;
  readonly id?: string;
  readonly className?: string;
}

/**
 * The home page's search, as a `GET` form.
 *
 * **A search is a URL.** Submitting navigates, so a result page can be shared, bookmarked, reloaded and reached
 * with the back button, and the whole thing works with JavaScript unavailable — which is also why this is a
 * server component with no state in it.
 *
 * **It is the home page's opening.** A marketplace's characteristic action is looking for something, so `/` opens
 * with a real working search field rather than a headline over a gradient. That also keeps a promise the home
 * page made before this increment: the page composes content an administrator arranged and invents no marketing
 * copy of its own, so the one thing it may lead with is a function.
 *
 * This is deliberately not the same component as `SearchForm` on `/search`, and the difference is the label. A
 * search page's field is the subject of the page and carries a visible label; an opening band's field is
 * self-evident from its placement and its placeholder, and a visible label above it would be noise. Merging the
 * two would mean a flag that switches the accessible name between visible and screen-reader-only, which is two
 * components wearing one name.
 *
 * `minLength` is the contract's own minimum, so the browser refuses a one-character search before a request is
 * made — the same rule the page enforces server-side, stated where a person can see it.
 */
export function SiteSearchForm({
  action,
  placeholder,
  submitLabel,
  defaultValue,
  id = 'site-search',
  className,
}: SiteSearchFormProps) {
  return (
    <form
      action={action}
      method="get"
      role="search"
      className={cx('flex w-full max-w-2xl items-center gap-2', className)}
    >
      <label htmlFor={id} className="sr-only">
        {placeholder}
      </label>
      <Input
        id={id}
        name="q"
        type="search"
        placeholder={placeholder}
        /* `exactOptionalPropertyTypes` is on, so an absent query is an absent prop, not an explicit undefined. */
        {...(defaultValue === undefined ? {} : { defaultValue })}
        minLength={SEARCH_MIN_QUERY_LENGTH}
        autoComplete="off"
        /* A query may be in either script whatever language the page is in, so the browser decides per value. */
        dir="auto"
        className="h-12 text-base"
      />
      <Button type="submit" size="lg">
        {submitLabel}
      </Button>
    </form>
  );
}
