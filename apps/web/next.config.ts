import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { referrerPolicyFor, sharedSecurityHeaders } from '@repo/config';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  async headers() {
    return [
      // Only the headers whose value is the same on both surfaces (0108). `Referrer-Policy` and `X-Robots-Tag`
      // differ between the marketplace and the console, and the two now share an origin: a second entry scoped to
      // `/admin/:path*` would be applied *in addition to* this one, leaving two conflicting values of the same key
      // on every console response. Both are emitted from the proxy instead, which is the one place that knows
      // which surface is answering.
      { source: '/:path*', headers: [...sharedSecurityHeaders()] },
      // Build assets are the one path the middleware does not run on, so they would otherwise lose the
      // `noindex` they have always had — and, since 0108, the `Referrer-Policy` the proxy now stamps. Every other
      // route gets both from the middleware, which is the only place that can tell a catalogue page from a
      // dashboard one, or the marketplace from the console.
      { source: '/_next/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }, referrerPolicyFor('web')] },
    ];
  },
};

export default withNextIntl(config);
