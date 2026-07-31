import { describe, expect, it } from 'vitest';
import { AI_LOOP_ENABLED_ENV, AI_LOOP_INBOX_KEYS_ENV, doorKey, gatedDoors, isAiLoopEnabled, isAiLoopGatedDoor } from './gate';

const env = (o: Record<string, string> = {}) => o as unknown as NodeJS.ProcessEnv;

describe('proof 16: the feature gate is OFF by default and OFF preserves current behaviour', () => {
  it('is off when the variable is absent', () => {
    expect(isAiLoopEnabled(env())).toBe(false);
  });

  it('is off for every truthy-looking value that is not exactly "true"', () => {
    for (const value of ['1', 'yes', 'TRUE', 'True', 'on', 'enabled', ' true', 'true ']) {
      expect(isAiLoopEnabled(env({ [AI_LOOP_ENABLED_ENV]: value })), value).toBe(false);
    }
  });

  it('leaves inbox 46 ungated while the master switch is off', () => {
    expect(isAiLoopGatedDoor('5', '46', env())).toBe(false);
    expect(isAiLoopGatedDoor('5', '46', env({ [AI_LOOP_INBOX_KEYS_ENV]: '5:46' }))).toBe(false);
  });

  it('is on only for the exact string "true"', () => {
    expect(isAiLoopEnabled(env({ [AI_LOOP_ENABLED_ENV]: 'true' }))).toBe(true);
  });
});

describe('per-door gating', () => {
  const on = env({ [AI_LOOP_ENABLED_ENV]: 'true' });

  it('reaches inbox 46 on account 5 when enabled', () => {
    expect(isAiLoopGatedDoor('5', '46', on)).toBe(true);
    expect(isAiLoopGatedDoor(5, 46, on)).toBe(true);
  });

  it('does NOT reach any other inbox on the same account even when enabled', () => {
    for (const inbox of ['3', '17', '36', '38']) {
      expect(isAiLoopGatedDoor('5', inbox, on), inbox).toBe(false);
    }
  });

  it('does NOT reach inbox 46 on a different account', () => {
    expect(isAiLoopGatedDoor('9', '46', on)).toBe(false);
  });

  it('treats a missing inbox id as ungated', () => {
    expect(isAiLoopGatedDoor('5', null, on)).toBe(false);
    expect(isAiLoopGatedDoor('5', undefined, on)).toBe(false);
    expect(isAiLoopGatedDoor('5', '   ', on)).toBe(false);
  });

  it('allows additive env doors without a code deploy', () => {
    const extra = env({ [AI_LOOP_ENABLED_ENV]: 'true', [AI_LOOP_INBOX_KEYS_ENV]: '5:99, 7:12' });
    expect(isAiLoopGatedDoor('5', '99', extra)).toBe(true);
    expect(isAiLoopGatedDoor('7', '12', extra)).toBe(true);
    // the hardcoded floor is never removed by the env var
    expect(gatedDoors(extra).has('5:46')).toBe(true);
  });

  it('builds a stable door key', () => {
    expect(doorKey(' 5 ', ' 46 ')).toBe('5:46');
  });
});
