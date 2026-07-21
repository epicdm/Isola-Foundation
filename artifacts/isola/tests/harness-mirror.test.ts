import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CTAS, byId } from '../lib/foh/cta-registry';

// Deterministic, repository-relative path — no guessing of working directories.
const HARNESS = join(__dirname, 'fixtures', 'foh-app.jsx');
const STAGE1 = ['cta_business_line','cta_hosted_pbx','cta_connect_pbx','cta_personal_line','cta_build_smart_front_desk','cta_talk_sales_assistant','cta_request_demo','cta_contact_support','cta_add_receptionist','cta_add_sales_assistant'];

describe('harness mirrors Next source', () => {
  it('harness fixture exists before content comparison', () => {
    expect(existsSync(HARNESS)).toBe(true);
  });
  it('every Stage-1 CTA id appears; later-route CTAs absent', () => {
    const jsx = readFileSync(HARNESS, 'utf8');
    for (const id of STAGE1) expect(jsx).toContain(id);
    for (const id of ['cta_upgrade_epic_pbx','cta_apply','cta_resume_setup']) expect(jsx.includes(id)).toBe(false);
    void CTAS;
  });
  it('harness has no qualification_started emit and no placeholder contact bypass', () => {
    const jsx = readFileSync(HARNESS, 'utf8');
    expect(/emit\(\s*['"]qualification_started/.test(jsx)).toBe(false);
    expect(jsx.includes("contact:'wa'") || jsx.includes("contact: 'wa'")).toBe(false);
  });
  it('source keeps comms-only assistant null', () => {
    for (const id of ['cta_business_line','cta_hosted_pbx','cta_connect_pbx','cta_personal_line']) expect(byId(id)!.assistant).toBeNull();
  });
});
