import { describe, expect, it } from 'vitest';
import {
  type BackupRef,
  backupId,
  backupsToPrune,
  DEFAULT_BACKUPS_KEPT,
  isJobFinished,
  type JobEvent,
  type JobState,
  nextJobState,
  OPERATION_STEPS,
  parseBackupId,
  removalBlockers,
} from '../../src/bundle/operations.js';

const JOB_STATES: JobState[] = ['queued', 'running', 'succeeded', 'failed', 'rolled-back'];
const JOB_EVENTS: JobEvent[] = ['start', 'succeed', 'fail', 'roll-back'];

describe('nextJobState', () => {
  const allowed: [JobState, JobEvent, JobState][] = [
    ['queued', 'start', 'running'],
    ['queued', 'fail', 'failed'],
    ['running', 'succeed', 'succeeded'],
    ['running', 'fail', 'failed'],
    ['running', 'roll-back', 'rolled-back'],
  ];

  it.each(allowed)('moves from %s on "%s" to %s', (state, event, next) => {
    expect(nextJobState(state, event)).toBe(next);
  });

  it('refuses every other combination', () => {
    const refused = JOB_STATES.flatMap((state) =>
      JOB_EVENTS.filter((event) => !allowed.some(([from, on]) => from === state && on === event))
        .filter((event) => nextJobState(state, event) !== undefined)
        .map((event) => `${state} + ${event}`),
    );
    expect(refused).toEqual([]);
  });

  it('knows which states are the end of a job', () => {
    expect(JOB_STATES.filter(isJobFinished)).toEqual(['succeeded', 'failed', 'rolled-back']);
    // A finished job never moves again.
    for (const state of JOB_STATES.filter(isJobFinished)) {
      expect(JOB_EVENTS.filter((event) => nextJobState(state, event))).toEqual([]);
    }
  });
});

describe('operation steps', () => {
  it('lists the steps of each operation in the order they run', () => {
    expect(OPERATION_STEPS).toEqual({
      stage: ['fetch', 'validate'],
      install: ['dependencies', 'place', 'enable'],
      update: ['dependencies', 'disable', 'backup', 'place', 'enable'],
      restore: ['disable', 'backup', 'place', 'enable'],
      remove: ['disable', 'erase', 'purge'],
    });
  });
});

describe('removalBlockers', () => {
  const data = { name: 'data', enabled: true, dependencies: [] };
  const off = { name: 'off', enabled: false, dependencies: ['data'] };
  const bundles = [
    data,
    { name: 'board', enabled: true, dependencies: ['data'] },
    { name: 'ticker', enabled: true, dependencies: ['board'] },
    off,
    { name: 'alone', enabled: true, dependencies: [] },
  ];

  it('names the enabled bundles that need the bundle, directly or through others', () => {
    expect(removalBlockers('data', bundles)).toEqual(['board', 'ticker']);
    expect(removalBlockers('board', bundles)).toEqual(['ticker']);
  });

  it('lets a bundle go that nobody enabled needs', () => {
    expect(removalBlockers('alone', bundles)).toEqual([]);
    expect(removalBlockers('ticker', bundles)).toEqual([]);
    expect(removalBlockers('data', [data, off])).toEqual([]);
  });

  it('is not blocked by what already cannot run for want of a disabled bundle', () => {
    const chain = [
      { name: 'a', enabled: true, dependencies: [] },
      { name: 'b', enabled: false, dependencies: ['a'] },
      { name: 'c', enabled: true, dependencies: ['b'] },
    ];
    expect(removalBlockers('a', chain)).toEqual([]);
  });

  it('blocks nothing when forced', () => {
    expect(removalBlockers('data', bundles, true)).toEqual([]);
  });

  it('ends on a dependency cycle', () => {
    const cycle = [
      { name: 'a', enabled: true, dependencies: ['b'] },
      { name: 'b', enabled: true, dependencies: ['a'] },
    ];
    expect(removalBlockers('a', cycle)).toEqual(['b']);
  });
});

describe('backups', () => {
  const time = Date.UTC(2026, 10, 24, 9, 5, 7, 42);

  it('names a backup by version and time, sortable and safe as a folder name', () => {
    const id = backupId('1.2.3', time);
    expect(id).toBe('1.2.3-20261124T090507042Z');
    expect(id).toMatch(/^[0-9A-Za-z.+-]+$/);
    expect(backupId('1.0.0-beta.1+build.5', time)).toBe('1.0.0-beta.1+build.5-20261124T090507042Z');
  });

  it('reads the version and time back', () => {
    expect(parseBackupId(backupId('1.2.3', time))).toEqual({
      id: '1.2.3-20261124T090507042Z',
      version: '1.2.3',
      time,
    });
    expect(parseBackupId(backupId('1.0.0-beta.1', time))?.version).toBe('1.0.0-beta.1');
  });

  it.each([
    '',
    '1.2.3',
    '../1.2.3-20261124T090507042Z',
    '1.2.3-20261124T090507042Z/..',
    '1.2.3-20261324T090507042Z',
    '1.2.3-20261124T090507042',
    'a\\b-20261124T090507042Z',
    '-20261124T090507042Z',
    '..-20261124T090507042Z',
  ])('refuses "%s" as the name of a backup', (id) => {
    expect(parseBackupId(id)).toBeUndefined();
  });

  it('keeps three backups unless told otherwise', () => {
    expect(DEFAULT_BACKUPS_KEPT).toBe(3);
  });

  it('prunes the oldest backups beyond the number to keep', () => {
    const backups: BackupRef[] = [3, 1, 5, 2, 4].map((day) => {
      const at = Date.UTC(2026, 0, day);
      return { id: backupId('1.0.0', at), version: '1.0.0', time: at };
    });
    expect(backupsToPrune(backups, 3)).toEqual([
      backupId('1.0.0', Date.UTC(2026, 0, 1)),
      backupId('1.0.0', Date.UTC(2026, 0, 2)),
    ]);
    expect(backupsToPrune(backups, 5)).toEqual([]);
    expect(backupsToPrune(backups, 9)).toEqual([]);
    expect(backupsToPrune(backups, 0)).toHaveLength(5);
    expect(backupsToPrune([], 3)).toEqual([]);
  });

  it('refuses a number of backups that makes no sense', () => {
    expect(() => backupsToPrune([], -1)).toThrow(/whole number/);
    expect(() => backupsToPrune([], 1.5)).toThrow(/whole number/);
  });
});
