import type { MoonCGError, ReplicantHandle } from '@mooncg/core';
import { getCurrentScope, onScopeDispose, type ShallowRef, shallowReadonly, shallowRef } from 'vue';

export interface UsedReplicant<T> {
  /** The current value. `undefined` until the first one arrives. Change it with `set`/`update`. */
  readonly data: Readonly<ShallowRef<T | undefined>>;
  /** Set while the replicant cannot be used, for example after the server removed it. */
  readonly error: Readonly<ShallowRef<MoonCGError | undefined>>;
  readonly ready: ReplicantHandle<T>['ready'];
  readonly set: ReplicantHandle<T>['set'];
  readonly update: ReplicantHandle<T>['update'];
  /**
   * Stops following the replicant. Inside a component's `setup()` or another effect scope this
   * happens by itself when the scope ends. Outside of one, nothing ends it: call `stop()`.
   */
  stop(): void;
}

/**
 * Follows a replicant. The refs are shallow: each change replaces the whole frozen value.
 *
 *     const { data, error, update } = useReplicant(mc.replicant('score'));
 */
export function useReplicant<T>(replicant: ReplicantHandle<T>): UsedReplicant<T> {
  const data = shallowRef(replicant.value);
  const error = shallowRef(replicant.error);
  const stopValue = replicant.subscribe((value) => {
    data.value = value;
  });
  const stopError = replicant.onErrorChange(() => {
    error.value = replicant.error;
  });
  const stop = () => {
    stopValue();
    stopError();
  };
  if (getCurrentScope()) onScopeDispose(stop);
  return {
    data: shallowReadonly(data),
    error: shallowReadonly(error),
    ready: replicant.ready,
    set: (next) => replicant.set(next),
    update: (recipe) => replicant.update(recipe),
    stop,
  };
}
