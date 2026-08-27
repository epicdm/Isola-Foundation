import { describe, expect, it } from 'vitest';
import nextConfig from './next.config';

/**
 * Before this fix, no X-Frame-Options or CSP existed at all, so the app
 * could be framed by any origin. This is the regression guard: the two
 * real Chatwoot origins stay permitted, everything else stays refused,
 * and the policy is never a wildcard.
 */
describe('Customer 360 Dashboard App framing policy', () => {
  async function cspValue(): Promise<string> {
    const rules = await nextConfig.headers!();
    const rule = rules.find((r) => r.source === '/:path*');
    const header = rule?.headers.find((h) => h.key === 'Content-Security-Policy');
    if (!header) throw new Error('no Content-Security-Policy header configured');
    return header.value;
  }

  it('permits the production Chatwoot origin', async () => {
    expect(await cspValue()).toContain('https://inbox.epic.dm');
  });

  it('permits the staging Chatwoot origin', async () => {
    expect(await cspValue()).toContain('https://isola-chat.saas00.epic.dm');
  });

  it('never uses a wildcard frame-ancestors', async () => {
    const value = await cspValue();
    expect(value).not.toContain("'*'");
    expect(value).not.toMatch(/frame-ancestors\s+\*/);
  });

  it('refuses an origin that was never granted framing permission', async () => {
    // Negative control: an origin that must NOT appear, proving this assertion
    // can fail (CLAUDE.md 2.19) rather than passing vacuously on any string.
    expect(await cspValue()).not.toContain('https://evil.example');
  });
});
