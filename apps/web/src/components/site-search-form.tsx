import { SEARCH_MIN_QUERY_LENGTH } from '@repo/contracts';
import { Button, FIELD_HERO, Input, cx } from '@repo/ui';

export interface SiteSearchFormProps {
  /** `/search` or `/ar/search`, so the form posts to the reader's own language. */
  readonly action: string;
  readonly placeholder: string;
  readonly submitLabel: string;
  /** The current query, when this form is rendered on a page that already searched. */
  readonly defaultValue?: string;
  readonly id?: string;
  /** `ink` is the home page's opening band, where the field sits on near-black. */
  readonly tone?: 'default' | 'ink';
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
  tone = 'default',
  className,
}: SiteSearchFormProps) {
  const ink = tone === 'ink';
  return (
    <form
      action={action}
      method="get"
      role="search"
      /*
        Stacked on a phone, side by side from `sm`. A field and a button sharing one row at 390px leaves the
        field about 180px wide, which truncates its own placeholder — which is exactly what the first mobile
        screenshot showed. A full-width field over a full-width button is the mobile layout, not a squeezed
        version of the desktop one.
      */
      className={cx('flex w-full max-w-2xl flex-col items-stretch gap-3 sm:flex-row sm:items-stretch', className)}
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
        className={FIELD_HERO}
      />
      {/*
        On the ink band the submit inverts to a light fill. It is the one bright element on a near-black
        surface, which is what makes it the obvious thing to press without any colour being involved.
      */}
      <Button type="submit" size="xl" variant={ink ? 'onInk' : 'primary'}>
        {submitLabel}
      </Button>
    </form>
  );
}
