import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, messageOf } from '../api.js';
import { live } from '../live.js';

interface OnAirAnswer {
  readonly onAir: boolean;
  readonly since?: string;
  readonly by?: string;
  readonly canSwitch: boolean;
}

/**
 * The "On Air" lock of the installation: while it is on, the server refuses whatever
 * interrupts a running bundle unless the request overrides the lock. Where it stands comes live from the
 * replicant `system:onAir`; who may switch it, and who did, from `GET /api/v1/on-air`.
 */
export const useOnAir = defineStore('onAir', () => {
  const onAir = ref(false);
  /** When it went on air, as the server says it. */
  const since = ref<string>();
  /** Who switched it on. Told to those who may switch it. */
  const by = ref<string>();
  const canSwitch = ref(false);
  /** Whether the server has said where the switch stands. Until then nothing is shown. */
  const known = ref(false);
  /** Why the last switch was refused; empty when it was not. */
  const problem = ref('');
  /** Whether the live connection has said where the switch stands. Then it has the say. */
  let followed = false;

  const take = (answer: OnAirAnswer, state = true) => {
    if (state) {
      onAir.value = answer.onAir === true;
      since.value = answer.since;
    }
    by.value = answer.by;
    canSwitch.value = answer.canSwitch === true;
    known.value = true;
  };

  /**
   * Asks the server. A server without the switch, or a refusal, leaves nothing shown. Once
   * the switch is followed live, this only adds what the live value lacks: an answer that
   * was on its way while the switch moved must not move it back.
   */
  async function refresh(): Promise<void> {
    try {
      take(await api.request<OnAirAnswer>('GET', '/api/v1/on-air'), !followed);
    } catch {
      known.value = false;
    }
  }

  /** Follows the switch live. Returns the function that stops it. */
  function follow(): () => void {
    const stop = live.follow<{ onAir?: boolean; since?: string } | null>(
      'system:onAir',
      (value) => {
        const next = value?.onAir === true;
        const changed = next !== onAir.value;
        followed = true;
        onAir.value = next;
        since.value = value?.since;
        // Who did it is not in what everyone may read.
        if (changed) void refresh();
      },
    );
    return () => {
      followed = false;
      stop();
    };
  }

  async function set(value: boolean): Promise<void> {
    problem.value = '';
    try {
      take(await api.request<OnAirAnswer>('PUT', '/api/v1/on-air', { onAir: value }));
    } catch (error) {
      problem.value = `Could not switch On Air ${value ? 'on' : 'off'}: ${messageOf(error)}`;
    }
  }

  /**
   * Decides how a change goes ahead that the lock refuses: `false` while off air, where
   * there is nothing to override; `true` once the person said to do it anyway, which the
   * request then says as `forceOnAir`; `undefined` when they called it off. `what` is the
   * change, such as `Reload "board"`. It is about the lock alone: a bundle that others
   * still need is not removed for it.
   */
  function overrideFor(what: string): boolean | undefined {
    if (!onAir.value) return false;
    const go = globalThis.confirm(
      `MoonCG is on air. ${what} anyway? It interrupts what the bundle shows right now.`,
    );
    return go ? true : undefined;
  }

  return { onAir, since, by, canSwitch, known, problem, refresh, follow, set, overrideFor };
});
