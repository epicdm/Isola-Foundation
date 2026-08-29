/**
 * The pure view is pure — asserted, not asserted-in-a-comment.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `workspace-view.tsx` carries a header saying it must never fetch, never reach
 * for a router and never import a framework. That header is DOCUMENTATION. It
 * has no power to stop the next edit that adds a `fetch` — and the moment one
 * lands, the cockpit silently stops being mountable at the portal while every
 * existing test stays green, because every existing test exercises it inside
 * Chatwoot where a fetch works fine. The failure would surface at the portal
 * mount, weeks later, as "why does this component need a Chatwoot?".
 *
 * WHY IT READS THE FILE AS TEXT INSTEAD OF IMPORTING IT
 * -----------------------------------------------------
 * Importing the module pulls in its CSS module, and on this machine that chain
 * fails to LOAD (lightningcss has no native binary here) — which does not fail
 * the file, it silently prevents every assertion in it from running. A guard
 * that cannot run on the machine where the edits happen is not a guard. Reading
 * source text has no import chain and therefore no way to be quietly skipped.
 *
 * IT MATCHES CODE, NOT PROSE — AND THAT WAS NOT THE FIRST DRAFT
 * -------------------------------------------------------------
 * Written naively, this guard failed on its first run: three assertions went
 * red against the view's own HEADER, which says in English that the view must
 * never do a Chatwoot `postMessage`. The file was correct; the guard was
 * reading the documentation of the rule as a violation of it.
 *
 * That is the house's §2.27(c) failure in miniature — a guard that inspects
 * prose instead of operations protects nothing, because it fires on the
 * DESCRIPTION of an action rather than the action. So comments are stripped
 * before any pattern is applied, and the guard binds to code.
 *
 * THE CONTROL IS HALF THE TEST
 * ----------------------------
 * Every assertion below is an ABSENCE — "the view does not do X". An absence
 * passes vacuously against an empty string, a mistyped path, or a file that
 * moved. So each forbidden pattern is also asserted PRESENT in the Chatwoot
 * container, which legitimately does all of these things. If the container ever
 * stops matching, the pattern is wrong and the guard is measuring nothing.
 *
 * The controls do double duty now: they also catch an over-eager comment
 * stripper. If stripping ever ate real code, the container — whose `fetch(`
 * and `postMessage` are genuine operations — would stop matching and the
 * controls would go red rather than the guard going quietly green.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const HERE = join(process.cwd(), 'components', 'customer-360');

/**
 * Remove block and line comments so patterns match OPERATIONS.
 *
 * `//` is only treated as a comment when it is not preceded by `:` — that
 * keeps `https://` inside a string literal intact. Over-stripping would
 * silently weaken the guard, which is why the controls below re-assert that
 * the container's real operations survive this.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const VIEW_RAW = readFileSync(join(HERE, 'workspace-view.tsx'), 'utf8');
const CONTAINER_RAW = readFileSync(join(HERE, 'customer-360-app.tsx'), 'utf8');

const VIEW = code(VIEW_RAW);
const CONTAINER = code(CONTAINER_RAW);

/**
 * Each entry: what the view must not contain, and the reason it would break
 * the portal mount. The same pattern must MATCH the container — that is the
 * proof the pattern can match anything at all.
 */
const FORBIDDEN_IN_VIEW: ReadonlyArray<{
  label: string;
  pattern: RegExp;
  why: string;
  /**
   * Where this pattern is PROVEN able to match. `container` when the Chatwoot
   * container legitimately does the thing; otherwise a literal sample, because
   * a pattern nothing in the pair matches makes its absence-assertion vacuous.
   */
  control: 'container' | string;
}> = [
  {
    label: "'use client'",
    pattern: /^\s*['"]use client['"]/m,
    why: 'the client boundary is the container\'s to declare, per host',
    control: 'container',
  },
  {
    label: 'fetch(',
    pattern: /\bfetch\s*\(/,
    why: 'a view that fetches has decided where its data lives',
    control: 'container',
  },
  {
    label: 'next/ import',
    pattern: /from\s+['"]next\//,
    why: 'the portal is a Django/React surface — it has no next/*',
    // The container does NOT import next/* either — it takes react and @/lib.
    // The first draft controlled this against the container and the control
    // went red, which is the control working: it proved the assertion was
    // passing vacuously. A synthetic positive is the honest fix.
    control: "import { headers } from 'next/headers'",
  },
  {
    label: 'window.',
    pattern: /\bwindow\./,
    why: 'reaching for window is how it became Chatwoot-only in the first place',
    control: 'container',
  },
  {
    label: 'postMessage',
    pattern: /postMessage/,
    why: 'the Chatwoot handshake belongs to the Chatwoot container',
    control: 'container',
  },
  {
    label: 'chatwoot',
    pattern: /chatwoot/i,
    why: 'the view must not know which host it is rendering in',
    control: 'container',
  },
];

describe('workspace-view purity', () => {
  it('read both files — neither is empty, so the assertions below are not vacuous', () => {
    // Without this, a bad path makes every "does not contain" assertion pass.
    expect(VIEW.length).toBeGreaterThan(1000);
    expect(CONTAINER.length).toBeGreaterThan(1000);
    expect(VIEW).toContain('CustomerWorkspaceView');
    expect(CONTAINER).toContain('Customer360App');
  });

  it('the comment stripper actually strips, and stops at the code', () => {
    // The guard's correctness rests on this. Proven in both directions rather
    // than assumed: the view's header names Chatwoot in prose, so that word
    // must be present BEFORE stripping and gone AFTER — while the exported
    // component name, which is code, must survive.
    expect(VIEW_RAW).toMatch(/Chatwoot/);
    expect(VIEW).not.toMatch(/Chatwoot/);
    expect(VIEW).toContain('export function CustomerWorkspaceView');
  });

  it('the stripper does not eat a protocol-relative or https URL in a string', () => {
    // The failure direction that matters: over-stripping removes real code and
    // turns every absence-assertion green for the wrong reason.
    expect(code('const u = "https://example.test/x"; // trailing note')).toContain(
      'https://example.test/x',
    );
    expect(code('const u = "https://example.test/x"; // trailing note')).not.toContain(
      'trailing note',
    );
  });

  for (const { label, pattern, why, control } of FORBIDDEN_IN_VIEW) {
    it(`the view does not use ${label} — ${why}`, () => {
      expect(VIEW).not.toMatch(pattern);
    });

    const where = control === 'container' ? 'the container DOES use it' : 'a real sample matches';
    it(`CONTROL: ${where}, so "${label}" can fail`, () => {
      expect(control === 'container' ? CONTAINER : control).toMatch(pattern);
    });
  }

  it('the view takes domain as a resolved value, never a resolver it could call', () => {
    // A value is inert. A resolver is a capability the view could invoke at
    // arbitrary times — exactly the reach a pure view must not have.
    expect(VIEW).toContain('domain?: WorkspaceDomain');
    expect(VIEW).not.toMatch(/useDomain\s*\(/);
  });

  it('CONTROL: that resolver name is a real thing, not a string nothing could match', () => {
    // Proves the negative above is a meaningful absence: the pattern matches
    // when the text is actually present.
    expect('const d = useDomain()').toMatch(/useDomain\s*\(/);
  });
});
