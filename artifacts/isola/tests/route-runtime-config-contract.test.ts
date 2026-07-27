import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression contract for the 2026-07-27 `/api/setup-status` defect.
 *
 * `app/api/setup-status/route.ts` exported only `GET`, took no `request`
 * argument, and touched no dynamic API. Under the App Router that makes a route
 * handler statically rendered: Next prerenders it once at build time and serves
 * a frozen body forever. `getSetupChecklist()` is a pure `process.env` read, so
 * every `configured` boolean was baked at build time and never re-evaluated.
 * The operator setup banner reported stale configuration indefinitely.
 *
 * This file has been wrong twice. Both failures had the same shape — a check
 * that read stronger than it was — so both are encoded as self-tests below.
 *
 *   PR #59: the sweep gated on the literal string `process.env` in the route
 *   file. `setup-status/route.ts` has none; it reads config through
 *   `getSetupChecklist()` from `@/lib/engines`. The sweep skipped the exact
 *   route it was written for.  → fixed by walking the local import graph.
 *
 *   PR #60: dynamic-API detection matched any identifier *named* `cookies`,
 *   `headers` or `draftMode` anywhere in that graph. `engines/chatwoot.ts`
 *   declares a plain local helper `function headers(config: ChatwootConfig)`,
 *   two hops from the route. That set `usesDynamicApi` and exempted the route
 *   before the env check could matter — so deleting `force-dynamic` from
 *   setup-status still passed the sweep.  → fixed by resolving the binding:
 *   only calls to names actually imported from `next/headers` count.
 *
 * The sweep asks two questions of a route's whole reachable local graph:
 *
 *   readsEnv       — does anything touch `process.env`?
 *   usesDynamicApi — does anything call a binding imported from `next/headers`?
 *                    Next bails those routes out to dynamic automatically.
 *
 * A route is an offender when it reads env, calls no dynamic API, has a `GET`
 * taking no `request` argument, and does not opt out. That is exactly the shape
 * that gets frozen at build time.
 *
 * node_modules is deliberately not traversed: a third-party package reading its
 * own env at import time is not what froze this endpoint, and following it would
 * make the graph unbounded.
 */

const ISOLA_ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ISOLA_ROOT, 'app');

/** Routes intentionally left statically rendered despite reading env.
 *  Add here only with a written reason — every entry is a deliberate decision. */
const EXEMPT: Record<string, string> = {};

const ENV_MARKER = /process\.env/;
const DYNAMIC_NAMES = ['cookies', 'headers', 'draftMode', 'connection'];
const EXTS = ['.ts', '.tsx', '.js', '.jsx'];

/**
 * Local identifiers in `src` that are bound to `next/headers` exports.
 * Handles `{ cookies }`, `{ headers as nextHeaders }`, and `* as h`.
 * An identifier that merely shares a name with a Next API — a local
 * `function headers()` — is deliberately NOT collected. That was the PR #60 bug.
 */
function dynamicBindings(src: string): { direct: string[]; namespaces: string[] } {
  const direct: string[] = [];
  const namespaces: string[] = [];

  const named = /import\s*\{([^}]*)\}\s*from\s*['"]next\/headers['"]/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(src)) !== null) {
    for (const clause of m[1].split(',')) {
      const parts = clause.trim().split(/\s+as\s+/);
      const imported = parts[0]?.trim();
      const local = (parts[1] ?? parts[0])?.trim();
      if (local && imported && DYNAMIC_NAMES.includes(imported)) direct.push(local);
    }
  }

  const ns = /import\s*\*\s*as\s+(\w+)\s*from\s*['"]next\/headers['"]/g;
  while ((m = ns.exec(src)) !== null) namespaces.push(m[1]);

  return { direct, namespaces };
}

function callsDynamicApi(src: string): boolean {
  const { direct, namespaces } = dynamicBindings(src);
  for (const name of direct) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(src)) return true;
  }
  for (const ns of namespaces) {
    if (new RegExp(`\\b${ns}\\s*\\.\\s*(${DYNAMIC_NAMES.join('|')})\\s*\\(`).test(src)) return true;
  }
  return false;
}

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
export function analyse(entry: string): { readsEnv: boolean; usesDynamicApi: boolean } {
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
    if (callsDynamicApi(src)) usesDynamicApi = true;
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

/** The sweep, factored out so the self-tests can run it against mutated source. */
function findOffenders(readFile: (f: string) => string): string[] {
  const offenders: string[] = [];
  for (const file of routeFiles(APP_DIR)) {
    const rel = path.relative(APP_DIR, file).replace(/\\/g, '/');
    if (rel in EXEMPT) continue;

    const src = readFile(file);
    if (OPTS_OUT.some((re) => re.test(src))) continue;

    const get = src.match(/export\s+(?:async\s+)?function\s+GET\s*\(([^)]*)\)/);
    if (!get) continue;                  // no GET — POST-only routes are always dynamic
    if (get[1].trim() !== '') continue;  // takes a request — dynamic

    const { readsEnv, usesDynamicApi } = analyse(file);
    if (!readsEnv) continue;
    if (usesDynamicApi) continue;        // Next bails these out automatically

    offenders.push(rel);
  }
  return offenders;
}

const SETUP_STATUS = path.join(APP_DIR, 'api/setup-status/route.ts');
const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('route runtime-config contract', () => {
  it('/api/setup-status opts out of static rendering', () => {
    expect(read(SETUP_STATUS), 'setup-status reports live env; it must declare force-dynamic')
      .toMatch(OPTS_OUT[0]);
  });

  it('self-test: the graph walk sees env reads made through a helper (PR #59 bug)', () => {
    expect(read(SETUP_STATUS), 'precondition: the read is indirect').not.toMatch(ENV_MARKER);
    expect(analyse(SETUP_STATUS).readsEnv, 'must see through @/lib/engines').toBe(true);
  });

  it('self-test: a local function named headers() does not count as a dynamic API (PR #60 bug)', () => {
    // engines/chatwoot.ts declares `function headers(config: ChatwootConfig)`, two
    // hops from setup-status. Name-matching treated that as cookies()/headers()
    // from next/headers and exempted the route.
    const chatwoot = path.join(ISOLA_ROOT, 'engines/chatwoot.ts');
    expect(fs.existsSync(chatwoot), 'fixture must exist').toBe(true);
    expect(read(chatwoot), 'fixture: a local helper named headers').toMatch(/function\s+headers\s*\(/);
    expect(callsDynamicApi(read(chatwoot)), 'a local helper is not next/headers').toBe(false);
    expect(analyse(SETUP_STATUS).usesDynamicApi, 'setup-status calls no dynamic API').toBe(false);
  });

  it('self-test: the sweep actually fails when force-dynamic is removed', () => {
    // The destructive test. If this passes trivially, the sweep is decorative.
    // Strip EVERY opt-out, not just force-dynamic. The first draft of this test
    // removed only `dynamic` and left `revalidate = 0` behind, so OPTS_OUT still
    // matched and the route was skipped before the sweep could judge it — the
    // same class of mistake this whole file exists to catch.
    const mutated = read(SETUP_STATUS)
      .replace(/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"];?\n?/, '')
      .replace(/export\s+const\s+revalidate\s*=\s*0;?\n?/, '');
    expect(
      OPTS_OUT.some((re) => re.test(mutated)),
      'mutation must leave no opt-out standing, or the sweep never sees the route',
    ).toBe(false);

    const offenders = findOffenders((f) => (f === SETUP_STATUS ? mutated : read(f)));
    expect(offenders, 'sweep must flag setup-status once force-dynamic is gone')
      .toContain('api/setup-status/route.ts');
  });

  it('no env-reading, session-less GET handler is left statically rendered', () => {
    expect(
      findOffenders(read),
      'these GET handlers reach process.env through their import graph, take no ' +
        'request argument, and call no next/headers API — Next will prerender them ' +
        "and freeze their values at build time. Add `export const dynamic = 'force-dynamic'`, " +
        'or add an entry to EXEMPT with a reason.',
    ).toEqual([]);
  });
});
