import { describe, it, expect } from 'vitest';
import { selectTemplateParams } from './notify-whatsapp';

/**
 * Regression cover for Meta error #132000 on `epic_internal_task_v1`.
 *
 * The sender used to collapse EVERY template to `[summaryLine]`, a single
 * parameter. `epic_internal_task_v1` declares five. Meta rejected every staff
 * dispatch outright, so the outbox row went pending -> failed -> retry and no
 * staff member ever received a task. These tests pin the selection rule that
 * fixed it, and pin the one-parameter fallback the voicemail-catch template
 * still depends on.
 */
describe('selectTemplateParams', () => {
  it('prefers an explicit templateParams array over summaryLine', () => {
    expect(
      selectTemplateParams({
        templateParams: ['#2589', 'NORMAL', 'Controlled internal test', 'ASAP', 'No due date'],
        summaryLine: 'Controlled internal test — BFF (due No due date)',
      }),
    ).toEqual(['#2589', 'NORMAL', 'Controlled internal test', 'ASAP', 'No due date']);
  });

  it('falls back to the single summaryLine parameter when none is supplied', () => {
    expect(selectTemplateParams({ summaryLine: 'From +1767: hi' })).toEqual(['From +1767: hi']);
  });

  it('ignores a templateParams array containing a blank slot, which Meta rejects', () => {
    expect(
      selectTemplateParams({ templateParams: ['a', '   ', 'c'], summaryLine: 'fallback' }),
    ).toEqual(['fallback']);
  });

  it('ignores a non-string templateParams entry', () => {
    expect(
      selectTemplateParams({ templateParams: ['a', 2, 'c'], summaryLine: 'fallback' }),
    ).toEqual(['fallback']);
  });

  it('ignores an empty templateParams array', () => {
    expect(selectTemplateParams({ templateParams: [], summaryLine: 'fallback' })).toEqual([
      'fallback',
    ]);
  });

  it('returns no parameters when the payload carries nothing usable', () => {
    expect(selectTemplateParams(null)).toEqual([]);
    expect(selectTemplateParams(undefined)).toEqual([]);
    expect(selectTemplateParams({})).toEqual([]);
    expect(selectTemplateParams({ summaryLine: '' })).toEqual([]);
  });
});
