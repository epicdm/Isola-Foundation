import { describe, it, expect } from 'vitest';
import {
  AI_AUTHORITY_STATES,
  DEFAULT_OWNERSHIP_STATE,
  HUMAN_AUTHORITY_STATES,
  LEGAL_TRANSITIONS,
  OWNERSHIP_STATES,
  canTransition,
  isOwnershipState,
  legacyHumanHandlingSuppresses,
  mayInvokeAi,
  projectHumanHandling,
  readOwnership,
  suppressesAutomatedReply,
  type OwnershipState,
} from './state';
import { AI_REPLY_OWNERSHIP_STATES } from '@/lib/clawith/contract';

describe('ownership vocabulary', () => {
  it('declares exactly the five required states', () => {
    expect([...OWNERSHIP_STATES]).toEqual([
      'AI_OWNED', 'HUMAN_REQUESTED', 'HUMAN_OWNED', 'HANDING_BACK', 'AI_RESUMED',
    ]);
  });

  it('shares one vocabulary with the Clawith wire contract', () => {
    // The store and the wire must not be able to disagree about what
    // "may the AI reply" means.
    expect([...AI_AUTHORITY_STATES].sort()).toEqual([...AI_REPLY_OWNERSHIP_STATES].sort());
  });

  it('partitions every state into exactly one authority set', () => {
    for (const s of OWNERSHIP_STATES) {
      expect(AI_AUTHORITY_STATES.has(s) !== HUMAN_AUTHORITY_STATES.has(s)).toBe(true);
    }
  });

  it('defaults to AI_OWNED', () => {
    expect(DEFAULT_OWNERSHIP_STATE).toBe('AI_OWNED');
  });

  it('rejects non-states', () => {
    for (const v of [null, undefined, '', 'ai_owned', 'HUMAN', 42, {}]) {
      expect(isOwnershipState(v)).toBe(false);
    }
  });
});

describe('reply authority', () => {
  it('permits AI invocation only in AI_OWNED and AI_RESUMED', () => {
    expect(mayInvokeAi('AI_OWNED')).toBe(true);
    expect(mayInvokeAi('AI_RESUMED')).toBe(true);
    expect(mayInvokeAi('HUMAN_REQUESTED')).toBe(false);
    expect(mayInvokeAi('HUMAN_OWNED')).toBe(false);
    expect(mayInvokeAi('HANDING_BACK')).toBe(false);
  });

  it('suppresses every automated reply in every HUMAN state', () => {
    for (const s of ['HUMAN_REQUESTED', 'HUMAN_OWNED', 'HANDING_BACK'] as OwnershipState[]) {
      expect(suppressesAutomatedReply(s)).toBe(true);
    }
  });

  it('suppresses during HANDING_BACK — reconciliation is not resumption', () => {
    expect(suppressesAutomatedReply('HANDING_BACK')).toBe(true);
  });
});

describe('compatibility projection', () => {
  it('projects human_handling from the state, not the other way round', () => {
    expect(projectHumanHandling('AI_OWNED')).toBe(false);
    expect(projectHumanHandling('AI_RESUMED')).toBe(false);
    expect(projectHumanHandling('HUMAN_REQUESTED')).toBe(true);
    expect(projectHumanHandling('HUMAN_OWNED')).toBe(true);
    expect(projectHumanHandling('HANDING_BACK')).toBe(true);
  });

  it('projection always agrees with suppression', () => {
    for (const s of OWNERSHIP_STATES) {
      expect(projectHumanHandling(s)).toBe(suppressesAutomatedReply(s));
    }
  });
});

describe('transition graph', () => {
  it('has no edge from any HUMAN state to an AI state except HANDING_BACK → AI_RESUMED', () => {
    const humanToAi: string[] = [];
    for (const from of HUMAN_AUTHORITY_STATES) {
      for (const to of LEGAL_TRANSITIONS[from]) {
        if (AI_AUTHORITY_STATES.has(to)) humanToAi.push(`${from}->${to}`);
      }
    }
    expect(humanToAi).toEqual(['HANDING_BACK->AI_RESUMED']);
  });

  it('never allows a self-transition', () => {
    for (const s of OWNERSHIP_STATES) expect(canTransition(s, s)).toBe(false);
  });

  it('allows escalation out of both AI states', () => {
    expect(canTransition('AI_OWNED', 'HUMAN_REQUESTED')).toBe(true);
    expect(canTransition('AI_RESUMED', 'HUMAN_REQUESTED')).toBe(true);
  });

  it('allows a failed handback back to HUMAN_OWNED', () => {
    expect(canTransition('HANDING_BACK', 'HUMAN_OWNED')).toBe(true);
  });

  it('refuses to resume from HUMAN_OWNED without passing through HANDING_BACK', () => {
    expect(canTransition('HUMAN_OWNED', 'AI_RESUMED')).toBe(false);
    expect(canTransition('HUMAN_OWNED', 'AI_OWNED')).toBe(false);
    expect(canTransition('HUMAN_REQUESTED', 'AI_OWNED')).toBe(false);
    expect(canTransition('HUMAN_REQUESTED', 'AI_RESUMED')).toBe(false);
  });

  it('names only known states on both sides of every edge', () => {
    for (const from of OWNERSHIP_STATES) {
      for (const to of LEGAL_TRANSITIONS[from]) expect(isOwnershipState(to)).toBe(true);
    }
  });
});

describe('readOwnership — fail closed', () => {
  it('reads a well-formed AI row', () => {
    expect(readOwnership({ ownership_state: 'AI_OWNED', ownership_episode: 0, human_handling: false }))
      .toEqual({ state: 'AI_OWNED', episode: 0, diverged: false });
  });

  it('reads a well-formed human row', () => {
    expect(readOwnership({ ownership_state: 'HUMAN_OWNED', ownership_episode: 3, human_handling: true }))
      .toEqual({ state: 'HUMAN_OWNED', episode: 3, diverged: false });
  });

  it('treats an unknown state as human-owned', () => {
    const v = readOwnership({ ownership_state: 'SOMETHING_NEW', ownership_episode: 2, human_handling: false });
    expect(v.state).toBe('HUMAN_OWNED');
    expect(v.diverged).toBe(true);
    expect(suppressesAutomatedReply(v.state)).toBe(true);
  });

  it('treats a missing state as human-owned rather than defaulting to AI', () => {
    const v = readOwnership({});
    expect(v.state).toBe('HUMAN_OWNED');
    expect(v.diverged).toBe(true);
  });

  it('treats an AI state with human_handling=true as a divergence, silencing the bot', () => {
    const v = readOwnership({ ownership_state: 'AI_OWNED', ownership_episode: 1, human_handling: true });
    expect(v.state).toBe('HUMAN_OWNED');
    expect(v.diverged).toBe(true);
  });

  it('normalises a malformed episode instead of propagating NaN', () => {
    expect(readOwnership({ ownership_state: 'AI_OWNED', ownership_episode: null }).episode).toBe(0);
    expect(readOwnership({ ownership_state: 'AI_OWNED', ownership_episode: -4 }).episode).toBe(0);
    expect(readOwnership({ ownership_state: 'AI_OWNED', ownership_episode: 2.7 }).episode).toBe(2);
  });
});

describe('legacy gate', () => {
  it('is exactly the pre-Commit-2 boolean test', () => {
    expect(legacyHumanHandlingSuppresses({ human_handling: true })).toBe(true);
    expect(legacyHumanHandlingSuppresses({ human_handling: false })).toBe(false);
    expect(legacyHumanHandlingSuppresses({})).toBe(false);
  });
});
