/**
 * The life of a bundle on a server. Running it:
 *
 *     installed ─enable→ enabling ─started→ running ─disable→ disabling ─stopped→ disabled
 *                           │                  │                  ▲              │
 *                           └──fail→ failed ←──┘                  │              │
 *                                      └──────────disable─────────┘              │
 *                         enabling ←──enable── (failed, disabled) ←──────────────┘
 *
 * Changing its files:
 *
 *     (new) installing ─placed→ installed          installing ─fail→ removed
 *     disabled ─update→ updating ─placed→ installed  updating ─fail→ failed
 *     disabled ─remove→ removing ─removed→ removed   removing ─fail→ failed
 *
 * The files of a bundle change only in `installing`, `updating` and `removing`, and the last
 * two are reached from `disabled` alone: whatever ran has been stopped by then. `updating`
 * ends with `placed` whichever version is in place afterwards, the new one or, after a
 * rollback, the old one. `removed` is the end: the bundle is gone.
 */
export const BUNDLE_STATES = [
  'installing',
  'installed',
  'enabling',
  'running',
  'failed',
  'disabling',
  'disabled',
  'updating',
  'removing',
  'removed',
] as const;
export type BundleState = (typeof BUNDLE_STATES)[number];

export const BUNDLE_EVENTS = [
  'enable',
  'started',
  'fail',
  'disable',
  'stopped',
  'update',
  'placed',
  'remove',
  'removed',
] as const;
export type BundleEvent = (typeof BUNDLE_EVENTS)[number];

const TRANSITIONS: Readonly<Record<BundleState, Partial<Record<BundleEvent, BundleState>>>> = {
  // A bundle that could not be put in place was never there.
  installing: { placed: 'installed', fail: 'removed' },
  installed: { enable: 'enabling', disable: 'disabling' },
  enabling: { started: 'running', fail: 'failed' },
  running: { fail: 'failed', disable: 'disabling' },
  failed: { enable: 'enabling', disable: 'disabling' },
  disabling: { stopped: 'disabled' },
  disabled: { enable: 'enabling', update: 'updating', remove: 'removing' },
  // `fail`: neither the new version nor the old one could be put in place.
  updating: { placed: 'installed', fail: 'failed' },
  // `fail`: the files could not be taken away and are still there.
  removing: { removed: 'removed', fail: 'failed' },
  removed: {},
};

/** The state an event leads to, or `undefined` if the event makes no sense in that state. */
export function nextBundleState(state: BundleState, event: BundleEvent): BundleState | undefined {
  return TRANSITIONS[state][event];
}
