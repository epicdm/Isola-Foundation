import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression contract for the 2026-07-27 `/api/setup-status` defect.
 *
 * `app/api/setup-status/route.ts` exported only `GET`, took no `request`
 * argument, and touched no dynamic API. Under the App Router that makes a
 * route handler statically rendered: Next prerenders it once at build time and
 * serves a frozen body forever. `getSetupChecklist()` is a pure `process.env`
 * read, so every `configured` boolean was baked at build time and never
 * re-evaluated. The operator setup banner reported stale configuration
 * indefinitely — including reporting FISERV_API_KEY as set long after the
 * secret had been removed from the deployment.
 *
 * The first version of this file swept for the literal string `process.env`
 * inside each route file. That was wrong in the most embarrassing possible
 * way: `setup-status/route.ts` contains no literal `process.env` — it reads
 * config through `getSetupChecklist()` from `@/lib/engines`. The sweep would
 * have skipped the exact route it was written for, and every future route that
 * reads config through a helper. Caught in review of PR #59.
 *
 * This version resolves each route's LOCAL import graph transitively (`@/…`
 * and relative specifiers) and asks two questions of the whole reachable set:
 *
 *   readsEnv       — does anything in the graph touch `process.env`?
 *   usesDynamicApi — does anything in the graph touch a request-scoped API
 *                    (`cookies()`, `headers()`, `draftMode()`)? Next bails
 *                    those routes out to dynamic automatically.
 *
 * A route is an offender when it reads env, never touches a dynamic API, has a
 * `GET` taking no `request` argument, and does not opt out explicitly. That is
 * exactly the shape that gets frozen at build time.
 *
 * node_modules is deliberately not traversed: a third-party package reading
 * its own env at import time is not what froze this endpoint, and following it
 * would make the graph unbounded.
 */

const ISOLA_ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ISOLA_ROOT, 'app');

/** Routes intentionally left statically rendered despite reading env.
 *  Add here only with a written reason — every entry is a deliberate decision. */
const EXEMPT: Record<string, string> = {};

const ENV_MARKER = /process\.env/;
const DYNAMIC_API = /\b(cookies|headers|draftMode)\s*\(/;
const EXTS = ['.ts', '.tsx', '.js', '.jsx'];

function resolveModule(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ISOLA_ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // bare specifier — node_modules, not traversed

  for (const ext of ['', ...EXTS]) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  for (const ext of EXTS) {
    const candidate = path.join(base, 'index' + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function localImports(src: string, fromFile: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import)\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const resolved = resolveModule(m[1], fromFile);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** Transitively analyse a route's local module graph. */
function analyse(entry: string): { readsEnv: boolean; usesDynamicApi: boolean } {
  const seen = new Set<string>();
  const queue = [entry];
  let readsEnv = false;
  let usesDynamicApi = false;

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    let src: string;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    if (ENV_MARKER.test(src)) readsEnv = true;
    if (DYNAMIC_API.test(src)) usesDynamicApi = true;
    if (readsEnv && usesDynamicApi) break; // verdict already settled

    queue.push(...localImports(src, file));
  }

  return { readsEnv, usesDynamicApi };
}

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) routeFiles(full, acc);
    else if (e.name === 'route.ts' || e.name === 'route.tsx') acc.push(full);
  }
  return acc;
}

const OPTS_OUT = [
  /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/,
  /export\s+const\s+revalidate\s*=\s*0/,
];

describe('route runtime-config contract', () => {
  it('/api/setup-status opts out of static rendering', () => {
    const src = fs.readFileSync(path.join(APP_DIR, 'api/setup-status/route.ts'), 'utf8');
    expect(src, 'setup-status reports live env; it must declare force-dynamic')
      .toMatch(OPTS_OUT[0]);
  });

  it('the sweep actually detects indirect env reads (self-test)', () => {
    // Guards the flaw this file shipped with in PR #59: setup-status contains
    // no literal `process.env`, so a naive text sweep skipped it. If import
    // following ever breaks, this fails before the sweep can go quietly green.
    const entry = path.join(APP_DIR, 'api/setup-status/route.ts');
    expect(fs.readFileSync(entry, 'utf8'), 'precondition: the read is indirect')
      .not.toMatch(ENV_MARKER);
    expect(analyse(entry).readsEnv, 'graph walk must see through @/lib/engines')
      .toBe(true);
  });

  it('no env-reading, session-less GET handler is left statically rendered', () => {
    const offenders: string[] = [];

    for (const file of routeFiles(APP_DIR)) {
      const rel = path.relative(APP_DIR, file).replace(/\\/g, '/');
      if (rel in EXEMPT) continue;

      const src = fs.readFileSync(file, 'utf8');
      if (OPTS_OUT.some((re) => re.test(src))) continue;

      const get = src.match(/export\s+(?:async\s+)?function\s+GET\s*\(([^)]*)\)/);
      if (!get) continue;                  // no GET — POST-only routes are always dynamic
      if (get[1].trim() !== '') continue;  // takes a request — dynamic

      const { readsEnv, usesDynamicApi } = analyse(file);
      if (!readsEnv) continue;
      if (usesDynamicApi) continue;        // Next bails these out automatically

      offenders.push(rel);
    }

    expect(
      offenders,
      'these GET handlers reach process.env through their import graph, take no ' +
        'request argument, and touch no dynamic API — Next will prerender them and ' +
        "freeze their values at build time. Add `export const dynamic = 'force-dynamic'`, " +
        'or add an entry to EXEMPT with a reason.',
    ).toEqual([]);
  });
});
