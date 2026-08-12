/**
 * P0 credential-containment guard — browser surfaces, enforced at the source.
 *
 * The exposure this prevents was not one bug, it was one *shape* repeated
 * across four files in two realms: take `magnus_sip_password`, put it in a
 * browser response, then render it, link it as `csc:<user>:<pass>@…`, and
 * encode it into a QR image.
 *
 * Asserting on a rendered DOM would only cover the pages someone remembered to
 * write a test for. Scanning the source covers every client component that
 * exists now or is added later, which is the property actually wanted: no
 * browser-side file may reference a SIP credential or build a credential-
 * bearing URI, ever.
 *
 * A QR image cannot be inspected after the fact — but it can only ever contain
 * what was passed to the encoder, so forbidding credential-bearing strings in
 * client code forbids credential-bearing QR codes by construction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(__dirname, '..');
const SCAN_DIRS = ['app', 'components', 'hooks', 'stores'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '__snapshots__']);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

const ALL_FILES = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));

/** A file is browser-side if it is a client component. Server routes may — and
 *  must — still handle the credential; they just may not send it to a browser. */
function isClientFile(src: string): boolean {
  return /^\s*['"]use client['"]/m.test(src);
}

function read(f: string): string {
  return readFileSync(f, 'utf8');
}

function rel(f: string): string {
  return relative(ROOT, f).split(sep).join('/');
}

describe('SIP credential surface', () => {
  it('finds files to scan (guards against a silently empty sweep)', () => {
    expect(ALL_FILES.length).toBeGreaterThan(50);
  });

  it('no client component references a SIP password field', () => {
    const offenders = ALL_FILES.filter((f) => {
      const src = read(f);
      if (!isClientFile(src)) return false;
      return /\b(sip_password|sipPassword|magnus_sip_password)\b/.test(src);
    }).map(rel);

    expect(offenders).toEqual([]);
  });

  it('no file builds a credential-bearing csc: or cloudsip: URI', () => {
    // Matches `csc:${user}:${pass}@…` and its string-concat equivalents: a
    // scheme followed by two interpolations separated by a colon.
    const CREDENTIAL_URI = /(csc|cloudsip|sip):\s*\$\{[^}]+\}\s*:\s*\$\{[^}]+\}/;
    const offenders = ALL_FILES.filter((f) => CREDENTIAL_URI.test(read(f))).map(rel);

    expect(offenders).toEqual([]);
  });

  it('no QR encoder sits in the same file as a SIP credential or telephony URI', () => {
    // The QR code was the least recoverable exposure — a photographable image
    // with no audit trail, and its contents cannot be inspected after the fact.
    //
    // Banning QR generation outright would be wrong: the wallet page encodes an
    // NBD MoBanking payment URL returned by the BFF, which is not a credential.
    // The enforceable rule is co-location — a file may encode QRs, or handle
    // telephony credentials, but never both. That is what makes "the QR cannot
    // contain a credential" a property of the code rather than a claim about it.
    const USES_QR = /\bQRCode\s*\.\s*to(DataURL|String|Canvas)|from\s+['"]qrcode['"]/;
    const TOUCHES_SIP = /\b(sip_password|sipPassword|magnus_sip_password)\b|(csc|cloudsip|sip):/;

    const offenders = ALL_FILES.filter((f) => {
      const src = read(f);
      return USES_QR.test(src) && TOUCHES_SIP.test(src);
    }).map(rel);

    expect(offenders).toEqual([]);
  });

  it('the two voice-line routes do not project the credential into their response', () => {
    for (const route of ['app/api/consumer/voice/line/route.ts', 'app/api/voice/line/route.ts']) {
      const src = read(join(ROOT, route));
      // The response object must not assign the credential to any wire field.
      expect(src, `${route} must not put the credential on the wire`).not.toMatch(
        /^\s*\w+\s*:\s*voiceLine\.magnus_sip_password\s*,/m,
      );
    }
  });

  it('server-side credential use that must be preserved is still present', () => {
    // A containment change that also broke top-up or click-to-call would be a
    // regression dressed as a fix. These paths send the credential
    // server-to-server to the BFF over HTTPS and never to a browser.
    const preserved = [
      'app/api/consumer/wallet/topup/bff/options/route.ts',
      'app/api/consumer/wallet/topup/bff/start/route.ts',
      'app/api/consumer/voice/callback/route.ts',
    ];
    for (const p of preserved) {
      const src = read(join(ROOT, p));
      expect(src, `${p} still needs the credential server-side`).toMatch(/magnus_sip_password/);
      expect(isClientFile(src), `${p} must not be a client component`).toBe(false);
    }
  });
});
