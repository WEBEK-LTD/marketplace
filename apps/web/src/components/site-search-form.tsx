import { SEARCH_MIN_QUERY_LENGTH } from '@repo/contracts';
import { Button, FIELD_HERO, FOCUS_WITHIN, Input, cx } from '@repo/ui';

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
  /**
   * How the field and its submit are put together.
   *
   * `split` is two controls in a row, which is what every form in the product uses. `fused` is one bar: a single
   * rounded container holding the field and the button, with the container taking the edge and the focus ring.
   *
   * The distinction exists because of a real defect rather than for variety. On the home page's opening band the
   * split form rendered as a white field and, beside it, a white button of the same height and radius — two
   * unrelated controls that happened to be adjacent, and on a phone two stacked white boxes that read as *two
   * fields*. A search bar is one object and has to look like one.
   */
  readonly shape?: 'split' | 'fused';
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
  shape = 'split',
  className,
}: SiteSearchFormProps) {
  const ink = tone === 'ink';

  const field = (
    <>
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
        {...(shape === 'fused'
          ? { bare: true, className: 'h-12 px-4 text-base sm:h-14 sm:px-6 sm:text-lg' }
          : { className: FIELD_HERO })}
      />
    </>
  );

  if (shape === 'fused') {
    return (
      <form
        action={action}
        method="get"
        role="search"
        /*
          One bar. The container carries the surface, the edge and — through `FOCUS_WITHIN` — the focus ring, so
          tabbing into the field rings the whole bar rather than drawing a second outline inside it.

          `rounded-2xl` rather than `rounded-full`: the bar holds a 56px button at a 12px radius, and a pill
          container around a rounded-rectangle button leaves two crescents of background at the ends. On a phone
          it becomes a column *inside the same container*, which is what keeps it one object at 390px instead of
          reverting to two stacked boxes.
        */
        className={cx(
          'flex w-full max-w-3xl flex-col gap-2 rounded-2xl bg-surface-raised p-2 ring-1 sm:flex-row sm:items-center sm:gap-2',
          ink ? 'ring-transparent' : 'ring-edge',
          FOCUS_WITHIN,
          className,
        )}
      >
        <div className="flex min-w-0 flex-1 items-center">{field}</div>
        {/*
          No `fullWidth`. In the column direction the form's default `align-items: stretch` already makes the
          button span the bar; from `sm` the row is `items-center` and the button takes its own width. Asking for
          `w-full` would have made it span the row on a desktop too.
        */}
        <Button type="submit" size="lg" variant="primary">
          {submitLabel}
        </Button>
      </form>
    );
  }

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
      {field}
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
