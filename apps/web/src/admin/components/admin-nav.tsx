'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  ADMIN_BUTTON_QUIET,
  ADMIN_NAV,
  ADMIN_NAV_LINK,
  ADMIN_NAV_LINK_ACTIVE,
  ADMIN_NAV_LINK_IDLE,
} from '../ui';

/**
 * The console's section navigation (Phase 7-F).
 *
 * **It is given what to render; it never decides.** The items arrive already filtered on the server by
 * the permissions the database reported, so this component holds only the sections the reader may open.
 * A section they may not open is not hidden here — it was never sent, so there is nothing in the page,
 * the RSC payload or the DOM to unhide. That is the difference between permission-driven navigation and
 * navigation with things switched off, and it is why this file contains no permission check: a check
 * here would imply the unfiltered list had arrived.
 *
 * **Responsive, in both directions.** A row of links from the medium breakpoint up, and below it a
 * disclosure button with the same list underneath — one `<nav>`, one list, one set of links, so there is
 * no second copy to fall out of step. The button is a real `<button>` with `aria-expanded` and
 * `aria-controls`, so it works from the keyboard and announces its state.
 *
 * **Active state is computed from the path**, marked with `aria-current="page"` as well as with weight,
 * so it is not carried by colour alone. A section and its own subpaths both count as active, which is
 * what makes a nested route still look like the section it belongs to.
 *
 * Spacing is written in logical properties, so Arabic mirrors from `dir="rtl"` on the document rather
 * than from a second stylesheet.
 */

export interface NavItem {
  readonly href: string;
  readonly label: string;
}

// The link's shape, its focus ring and its two states all come from the console's grammar, so a section
// link cannot drift away from the rest of the console or from the public site's focus behaviour.

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNav({
  items,
  label,
  menuLabel,
}: {
  readonly items: readonly NavItem[];
  readonly label: string;
  readonly menuLabel: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  const links = items.map((item) => {
    const active = isActive(pathname, item.href);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={active ? 'page' : undefined}
          className={`${ADMIN_NAV_LINK} ${active ? ADMIN_NAV_LINK_ACTIVE : ADMIN_NAV_LINK_IDLE}`}
        >
          {item.label}
        </Link>
      </li>
    );
  });

  return (
    <nav aria-label={label} className={ADMIN_NAV}>
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-controls="admin-sections"
          className={`${ADMIN_BUTTON_QUIET} my-2 md:hidden`}
        >
          {menuLabel}
        </button>
        <ul
          id="admin-sections"
          className={`${open ? 'block' : 'hidden'} pb-2 md:flex md:flex-wrap md:items-center md:gap-1 md:pb-0`}
        >
          {links}
        </ul>
      </div>
    </nav>
  );
}
