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
    return [{ source: '/:path*', headers: [...staticSecurityHeaders('admin')] }];
  },
};

export default withNextIntl(config);
