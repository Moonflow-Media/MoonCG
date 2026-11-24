import { describe, expect, it } from 'vitest';
import { qualifyReplicantName, ReplicantRegistry } from '../../src/replicant/registry.js';

describe('qualifyReplicantName', () => {
  it('puts a bare name into the given bundle namespace', () => {
    expect(qualifyReplicantName('score', 'scoreboard')).toBe('scoreboard:score');
  });

  it('keeps an already qualified name', () => {
    expect(qualifyReplicantName('team-data:teams', 'scoreboard')).toBe('team-data:teams');
  });
});

describe('ReplicantRegistry', () => {
  it('declares a replicant with its initial value and mapped permissions', () => {
    const registry = new ReplicantRegistry();
    registry.declare('scoreboard', 'score', {
      initial: { home: 0 },
      read: 'view',
      write: 'operate',
    });

    const entry = registry.get('scoreboard:score');

    expect(entry?.replicant.value).toEqual({ home: 0 });
    expect(entry?.readPermission).toBe('bundle:scoreboard:view');
    expect(entry?.writePermission).toBe('bundle:scoreboard:operate');
  });

  it('uses the implicit bundle permission when none is mapped', () => {
    const registry = new ReplicantRegistry();
    registry.declare('scoreboard', 'score', { initial: null });
    expect(registry.get('scoreboard:score')).toMatchObject({
      readPermission: 'bundle:scoreboard:?',
      writePermission: 'bundle:scoreboard:?',
    });
  });

  it('returns undefined for an undeclared replicant', () => {
    expect(new ReplicantRegistry().get('scoreboard:score')).toBeUndefined();
  });

  it('refuses to declare the same replicant twice', () => {
    const registry = new ReplicantRegistry();
    registry.declare('scoreboard', 'score', { initial: 1 });
    expect(() => registry.declare('scoreboard', 'score', { initial: 2 })).toThrow(
      /already declared/,
    );
  });

  it('passes the validator to the engine', () => {
    const registry = new ReplicantRegistry();
    const { replicant } = registry.declare('b', 'n', { initial: 1, validate: () => ['never'] });
    expect(replicant.applyOp({ patches: [{ op: 'replace', path: '', value: 2 }] })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});
