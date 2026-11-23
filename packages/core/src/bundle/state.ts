/**
 * The life of a bundle on a server:
 *
 *     installed ─enable→ enabling ─started→ running ─disable→ disabling ─stopped→ disabled
 *                           │                  │                  ▲              │
 *                           └──fail→ failed ←──┘                  │              │
 *                                      └──────────disable─────────┘              │
 *                         enabling ←──enable── (failed, disabled) ←──────────────┘
 */
export type BundleState =
  | 'installed'
  | 'enabling'
  | 'running'
  | 'failed'
  | 'disabling'
  | 'disabled';

export type BundleEvent = 'enable' | 'started' | 'fail' | 'disable' | 'stopped';

const TRANSITIONS: Readonly<Record<BundleState, Partial<Record<BundleEvent, BundleState>>>> = {
  installed: { enable: 'enabling', disable: 'disabling' },
  enabling: { started: 'running', fail: 'failed' },
  running: { fail: 'failed', disable: 'disabling' },
  failed: { enable: 'enabling', disable: 'disabling' },
  disabling: { stopped: 'disabled' },
  disabled: { enable: 'enabling' },
};

/** The state an event leads to, or `undefined` if the event makes no sense in that state. */
export function nextBundleState(state: BundleState, event: BundleEvent): BundleState | undefined {
  return TRANSITIONS[state][event];
}
