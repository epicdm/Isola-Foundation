import { describe, expect, it } from 'vitest';
import {
  isLane2BrokerDoor,
  lane2BrokerAllowedDoors,
  lane2DoorKey,
  LANE2_BROKER_ALLOWED_DOOR_KEYS_ENV,
} from './broker-allowlist';

describe('lane2DoorKey', () => {
  it('joins account and inbox, trimming whitespace', () => {
    expect(lane2DoorKey(' 5 ', ' 47 ')).toBe('5:47');
    expect(lane2DoorKey(5, 47)).toBe('5:47');
  });
});

describe('lane2BrokerAllowedDoors', () => {
  it('always includes the hardcoded floor 5:47', () => {
    expect(lane2BrokerAllowedDoors({})).toEqual(new Set(['5:47']));
  });

  it('is additive with the env var, never replacing the floor', () => {
    const env = { [LANE2_BROKER_ALLOWED_DOOR_KEYS_ENV]: '5:48, 6:1' } as NodeJS.ProcessEnv;
    expect(lane2BrokerAllowedDoors(env)).toEqual(new Set(['5:47', '5:48', '6:1']));
  });

  it('ignores blank entries in the env var', () => {
    const env = { [LANE2_BROKER_ALLOWED_DOOR_KEYS_ENV]: '5:47,, ,' } as NodeJS.ProcessEnv;
    expect(lane2BrokerAllowedDoors(env)).toEqual(new Set(['5:47']));
  });
});

describe('isLane2BrokerDoor', () => {
  it('allows the hardcoded 5:47 floor', () => {
    expect(isLane2BrokerDoor(5, 47, {})).toBe(true);
    expect(isLane2BrokerDoor('5', '47', {})).toBe(true);
  });

  it('proves AgentBot 4 / inbox 46 is never a lane2 door by default', () => {
    expect(isLane2BrokerDoor(5, 46, {})).toBe(false);
  });

  it('rejects an unlisted door', () => {
    expect(isLane2BrokerDoor(5, 99, {})).toBe(false);
  });

  it('rejects missing account or inbox rather than treating them as wildcards', () => {
    expect(isLane2BrokerDoor(null, 47, {})).toBe(false);
    expect(isLane2BrokerDoor(5, undefined, {})).toBe(false);
    expect(isLane2BrokerDoor(5, '', {})).toBe(false);
  });

  it('allows an additive env door without disturbing the floor', () => {
    const env = { [LANE2_BROKER_ALLOWED_DOOR_KEYS_ENV]: '5:50' } as NodeJS.ProcessEnv;
    expect(isLane2BrokerDoor(5, 50, env)).toBe(true);
    expect(isLane2BrokerDoor(5, 47, env)).toBe(true);
    expect(isLane2BrokerDoor(5, 46, env)).toBe(false);
  });
});
