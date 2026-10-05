import { Controller, Get, Query } from '@nestjs/common';
import {
  NAVIGATION_MENU_KEYS,
  publicLocaleOf,
  type NavigationMenuKey,
  type PublicNavigationResponse,
} from '@repo/contracts';
import { NavigationPublicService } from '../cms/navigation-public.service.js';

/**
 * `GET /v1/navigation` — the public navigation menus (0094).
 *
 * One read, no user context, no body, no pagination. The internal BFF credential guard still applies — it covers
 * every `/v1` route by construction — so the browser reaches this through the BFF like everything else.
 *
 * **`menus` names which of the three keys to return**, so a page that renders a header, a footer and a mobile
 * drawer asks once. An unrecognised key is ignored rather than becoming a 400: the set of placements is this
 * platform's own (owner decision 1), and a caller asking for one that does not exist has asked for nothing.
 * Asking for nothing at all returns all three, which is what every public page wants.
 *
 * `locale` selects a representation and never a subset: the same menus come back in either language, labelled in
 * the one that was asked for, with English as the fallback where no Arabic label was written.
 *
 * **An empty `menus` array is a real answer**, not a 404: a marketplace whose administrator has composed no menu
 * has navigation — the web app's own neutral chrome (owner decision 7) — and a 404 here would turn a fresh
 * install into a broken site.
 *
 * **The controller decides nothing.** Which menus are active, which items they can still show and what order they
 * appear in are decided in migrations 0030 and 0094; whether a menu has anything left to show is decided in the
 * service, once.
 */
@Controller('v1')
export class NavigationController {
  constructor(private readonly navigation: NavigationPublicService) {}

  @Get('navigation')
  async menus(
    @Query('menus') menus?: string,
    @Query('locale') locale?: string,
  ): Promise<PublicNavigationResponse> {
    const resolved = await this.navigation.menus({
      menuKeys: keysOf(menus),
      locale: publicLocaleOf(locale),
    });
    return { menus: [...resolved] };
  }
}

/**
 * The menus asked for, in the order they were asked for.
 *
 * A key nobody has is dropped rather than refused, and an empty request means all three. Duplicates are collapsed
 * so a caller cannot ask for the same menu twice and be sent it twice.
 */
function keysOf(menus: string | undefined): readonly NavigationMenuKey[] {
  if (typeof menus !== 'string' || menus.trim() === '') return NAVIGATION_MENU_KEYS;
  const served = new Set<string>(NAVIGATION_MENU_KEYS);
  const asked: NavigationMenuKey[] = [];
  for (const raw of menus.split(',')) {
    const key = raw.trim();
    if (served.has(key) && !asked.includes(key as NavigationMenuKey)) asked.push(key as NavigationMenuKey);
  }
  return asked;
}
