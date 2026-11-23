import type { MoonCGError, ReplicantHandle } from '@mooncg/core';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * Returns a replicant's current value and re-renders the component when it changes. The value
 * is `undefined` until the first one arrives. It is the replicant's own frozen snapshot, which
 * is only replaced when the value changes, so React sees a stable identity between changes.
 *
 *     const score = useReplicant(scoreReplicant);
 *
 * Create the handle once, outside the component, and write with its `set` and `update`.
 */
export function useReplicant<T>(replicant: ReplicantHandle<T>): T | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => replicant.subscribe(() => onChange()),
    [replicant],
  );
  const getSnapshot = useCallback(() => replicant.value, [replicant]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Returns the replicant's `error`: set while it cannot be used, for example after the server
 * removed it, and `undefined` otherwise. Re-renders only when that changes.
 *
 *     const error = useReplicantError(scoreReplicant);
 */
export function useReplicantError(replicant: ReplicantHandle<unknown>): MoonCGError | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => replicant.onErrorChange(onChange),
    [replicant],
  );
  const getSnapshot = useCallback(() => replicant.error, [replicant]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
