import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Served at root path; PORT is injected by Replit automatically.
  allowedDevOrigins: ['*'],

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
