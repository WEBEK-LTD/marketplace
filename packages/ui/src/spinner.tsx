/**
 * A pending indicator, for inside a button or beside a status line.
 *
 * It is `aria-hidden`: a spinner is a picture of waiting, and the waiting itself is announced by the
 * `aria-busy` on the control or by the status text beside it. Two announcements of one fact is noise.
 *
 * Built from a border rather than an SVG so it inherits `currentColor`, which is what lets it sit on the dark
 * primary button and the light secondary one without a variant of its own. The `animate-spin` stops under
 * `prefers-reduced-motion`, which `globals.css` enforces product-wide — and that is fine: the control is still
 * disabled and still labelled, so nothing is carried by the motion.
 */
export function Spinner({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent${
        className === undefined ? '' : ` ${className}`
      }`}
    />
  );
}
