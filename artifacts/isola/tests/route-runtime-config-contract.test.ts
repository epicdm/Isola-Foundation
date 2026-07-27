import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression contract for the 2026-07-27 `/api/setup-status` defect.
 *
 * `app/api/setup-status/route.ts` exported only `GET`, took no `request`
 * argument, and touched no dynamic API. Under the App Router that makes a
 * route handler statically rendered: Next prerenders it once at build time
 * and serves a frozen body forever. Because `getSetupChecklist()` is a pure
 * `process.env` read, every `configured` boolean was baked at build time and
 * never re-evaluated at runtime. The operator setup banner reported stale
 * configuration indefinitely — including reporting FISERV_API_KEY as set for
 * hours after the secret had actually been removed from the deployment.
 *
 * Routes that report LIVE runtime configuration must opt out of static
 * rendering explicitly. Routes that read a session (cookies()/headers()) are
 * bailed out to dynamic by Next automatically and do not need the export;
 * routes that return a constant are safe to prerender. The dangerous shape is
 * specifically: reads process.env, takes no request argument, no session.
 */

const APP_DIR = path.join(__dirname, '..', 'app');

/** Routes whose GET reads process.env but is intentionally NOT force-dynamic.
 *  Add here only with a written reason — every entry is a deliberate decision. */
const EXEMPT: Record<string, string> = {};

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) routeFiles(full, acc);
    else if (e.name === 'route.ts' || e.name === 'route.tsx') acc.push(full);
  }
  return acc;
}

const SESSION_MARKERS = [
  'cookies(', 'headers(', 'getConsumerSession', 'getSession', 'requireAdmin', 'getAuthUser',
];

describe('route runtime-config contract', () => {
  it('/api/setup-status opts out of static rendering', () => {
    const src = fs.readFileSync(path.join(APP_DIR, 'api/setup-status/route.ts'), 'utf8');
    expect(src, 'setup-status reports live env; it must declare force-dynamic')
      .toMatch(/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/);
  });

  it('no env-reading, session-less GET handler is left statically rendered', () => {
    const offenders: string[] = [];

    for (const file of routeFiles(APP_DIR)) {
      const rel = path.relative(APP_DIR, file).replace(/\\/g, '/');
      if (rel in EXEMPT) continue;

      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes('process.env')) continue;
      if (/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/.test(src)) continue;
      if (/export\s+const\s+revalidate\s*=\s*0/.test(src)) continue;

      const get = src.match(/export\s+(?:async\s+)?function\s+GET\s*\(([^)]*)\)/);
      if (!get) continue;                       // no GET — POST-only routes are always dynamic
      if (get[1].trim() !== '') continue;       // takes a request — dynamic
      if (SESSION_MARKERS.some((m) => src.includes(m))) continue; // Next bails these out

      offenders.push(rel);
    }

    expect(
      offenders,
      'these GET handlers read process.env with no request arg and no session, so Next will ' +
        'prerender them and freeze their values at build time. Add ' +
        "`export const dynamic = 'force-dynamic'`, or add an entry to EXEMPT with a reason.",
    ).toEqual([]);
  });
});
