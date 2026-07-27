import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Served at root path; PORT is injected by Replit automatically.
  allowedDevOrigins: ['*'],

  /**
   * Build output directory.
   *
   * Replit runs its OWN `next dev` for this artifact (the PNPM_WORKSPACE agent stack)
   * at the same time as the configured Preview workflow. Two Next processes sharing a
   * single .next directory race on the webpack pack cache. Observed in
   * .replit-preview-logs/web.log:
   *
   *   [webpack.cache.PackFileCacheStrategy] Restoring pack failed ... incorrect header check
   *   [webpack.cache.PackFileCacheStrategy] Caching failed: ENOENT: rename
   *     '.next/cache/webpack/client-development/0.pack.gz_' -> '0.pack.gz'
   *
   * One process renames a temp pack the other has already moved. The route manifest
   * then goes stale and existing routes are served as _not-found (spurious 404) or
   * fail outright (spurious 5xx) — reproduced as an identical GET /products returning
   * 200, 200, 200, 404, 200. Giving the Preview workflow its own build directory
   * removes the shared mutable state rather than trying to police the processes.
   *
   * NEXT_DIST_DIR is set ONLY by scripts/run-replit-preview.sh. It is unset for
   * `next build`, `next start` and the Autoscale deployment, which therefore keep
   * using .next exactly as before. Production output is unchanged.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',

  /**
   * Proxy all /auth/* requests to the Express API server running on localhost:8080.
   *
   * In Autoscale (and in dev), Next.js is the single public-facing entry point.
   * Express handles OIDC auth but is only reachable internally. This rewrite makes
   * /auth/login, /auth/callback, /auth/logout, and /auth/user available on the
   * same origin as the frontend without any cross-origin issues.
   *
   * Request headers (including Cookie and x-forwarded-host) are forwarded
   * transparently so Express can read OIDC state cookies and construct the correct
   * callback URL.
   */
  async rewrites() {
    return [
      {
        source: '/auth/:path*',
        destination: 'http://localhost:8080/auth/:path*',
      },
    ];
  },

  images: {
    remotePatterns: [
      // Google profile photos (Replit Auth via Google)
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      { protocol: 'https', hostname: 'lh4.googleusercontent.com' },
      // Replit avatar CDN
      { protocol: 'https', hostname: '*.replit.com' },
      { protocol: 'https', hostname: 'replit.com' },
      // Generic CDN fallback for other providers
      { protocol: 'https', hostname: '*.googleusercontent.com' },
    ],
  },
};

export default nextConfig;
