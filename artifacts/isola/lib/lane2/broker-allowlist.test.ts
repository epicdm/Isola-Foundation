import { describe, expect, it } from 'vitest';
import {
  isLane2BrokerDoor,
  lane2BrokerAllowedDoors,
  lane2DoorKey,
  LANE2_BROKER_ALLOWED_DOOR_KEYS_ENV,
} from './broker-allowlist';

/**
 * A realistic ProcessEnv fixture — includes NODE_ENV because the actual
 * Foundation build (next/types/global.d.ts) declares it as a required
 * property on the global NodeJS.ProcessEnv. Each test spreads this and adds
 * only the specific var it's exercising, rather than casting an incomplete
 * object past the type system (dec-pr68-test-fixes-no-gate-waiver-2026-08-02).
 */
const BASE_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test' };

describe('lane2DoorKey', () => {
  it('joins account and inbox, trimming whitespace', () => {
    expect(lane2DoorKey(' 5 ', ' 47 ')).toBe('5:47');
    expect(lane2DoorKey(5, 47)).toBe('5:47');
  });
});

describe('lane2BrokerAllowedDoors', () => {
  it('always includes the hardcoded floor 5:47', () => {
    expect(lane2BrokerAllowedDoors(BASE_ENV)).toEqual(new Set(['5:47']));
  });

  it('is additive with the env var, never replacing the floor', () => {
    const env: NodeJS.ProcessEnv = { ...BASE_ENV, [LANE2_BROKER_ALLOWED_DOOR_KEYS_ENV]: '5:48, 6:1' };
    expect(lane2BrokerAllowedDoors(env)).toEqual(new Set(['5:47', '5:48', '6:1']));
  });

  it('ignores blank entries in the env var', () => {
    const env: NodeJS.ProcessEnv = { ...BASE_ENV, [LANE2_BROKER_ALLOWED_DOOR_KEYS_ENV]: '5:47,, ,' };
    expect(lane2BrokerAllowedDoors(env)).toEqual(new Set(['5:47']));
  });
});

describe('isLane2BrokerDoor', () => {
  it('allows the hardcoded 5:47 floor', () => {
    expect(isLane2BrokerDoor(5, 47, BASE_ENV)).toBe(true);
    expect(isLane2BrokerDoor('5', '47', BASE_ENV)).toBe(true);
  });

  it('proves AgentBot 4 / inbox 46 is never a lane2 door by default', () => {
    expect(isLane2BrokerDoor(5, 46, BASE_ENV)).toBe(false);
  });

  it('rejects an unlisted door', () => {
    expect(isLane2BrokerDoor(5, 99, BASE_ENV)).toBe(false);
  });

  it('rejects missing account or inbox rather than treating them as wildcards', () => {
    expect(isLane2BrokerDoor(null, 47, BASE_ENV)).toBe(false);
    expect(isLane2BrokerDoor(5, undefined, BASE_ENV)).toBe(false);
    expect(isLane2BrokerDoor(5, '', BASE_ENV)).toBe(false);
  });

  it('allows an additive env door without disturbing the floor', () => {
    const env: NodeJS.ProcessEnv = { ...BASE_ENV, [LANE2_BROKER_ALLOWED_DOOR_KEYS_ENV]: '5:50' };
    expect(isLane2BrokerDoor(5, 50, env)).toBe(true);
    expect(isLane2BrokerDoor(5, 47, env)).toBe(true);
    expect(isLane2BrokerDoor(5, 46, env)).toBe(false);
  });
});
