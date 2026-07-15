import { type NextRequest } from 'next/server';

/**
 * Build an absolute URL using the public-facing origin from proxy headers.
 *
 * Next.js route handlers receive requests at the internal address
 * (e.g. http://localhost:23359/...).  Using req.url as a base for redirects
 * sends the browser to localhost, which it can't reach.  The Replit proxy
 * sets x-forwarded-host / x-forwarded-proto so we can reconstruct the real
 * public URL instead.
 */
export function publicUrl(path: string, req: NextRequest): URL {
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host =
    req.headers.get('x-forwarded-host') ??
    req.headers.get('host') ??
    'localhost';
  return new URL(path, `${proto}://${host}`);
}
