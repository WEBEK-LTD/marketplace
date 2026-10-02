import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { staticSecurityHeaders } from '@repo/config';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  async headers() {
    return [
      { source: '/:path*', headers: [...staticSecurityHeaders('web')] },
      // Build assets are the one path the middleware does not run on, so they would otherwise lose the
      // `noindex` they have always had. Every other route gets its robots header from the middleware,
      // which is the only place that can tell a catalogue page from a dashboard one.
      { source: '/_next/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] },
    ];
  },
};

export default withNextIntl(config);
