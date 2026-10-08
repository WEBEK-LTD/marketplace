'use client';

import { Button, Dialog } from '@repo/ui';
import { useState, type ReactNode } from 'react';

export interface SiteMenuProps {
  /** The composed navigation and the search form, rendered on the server and handed in. */
  readonly children: ReactNode;
  readonly menuLabel: string;
  readonly closeLabel: string;
  readonly title: string;
}

/**
 * The navigation, on a viewport too narrow for a row of entries.
 *
 * A drawer rather than a second copy of the menu stacked under the header. The old header did the latter, which
 * pushed the page's content down by the height of the menu on every phone — the first thing that reads as an
 * unfinished site. Here the entries are off-screen until asked for, so the header stays one row tall.
 *
 * The only client component in the site chrome, and it holds one boolean. Everything inside it — the composed
 * menu, the search form — is rendered on the server and passed through as children, so opening the drawer ships
 * no extra markup and the menu is in the HTML a crawler sees.
 *
 * `Dialog` supplies the behaviour: focus moves in and is trapped, Escape closes, the page behind goes inert, and
 * focus returns to this button on close. The drawer docks to the inline-end edge, so it comes from the right in
 * English and the left in Arabic without a second rule.
 */
export function SiteMenu({ children, menuLabel, closeLabel, title }: SiteMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="md" onClick={() => setOpen(true)} aria-expanded={open} aria-haspopup="dialog">
        <MenuMark />
        <span className="sr-only sm:not-sr-only">{menuLabel}</span>
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        placement="drawer"
        closeLabel={closeLabel}
      >
        {children}
      </Dialog>
    </>
  );
}

/** Three rules. Drawn rather than imported so the chrome pulls in no icon for one glyph. */
function MenuMark() {
  return (
    <span aria-hidden="true" className="flex size-4 flex-col justify-center gap-1">
      <span className="h-0.5 w-4 bg-current" />
      <span className="h-0.5 w-4 bg-current" />
      <span className="h-0.5 w-4 bg-current" />
    </span>
  );
}
