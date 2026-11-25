import { isPlainObject, type Json, MoonCGError } from '@mooncg/core';
import type { SettingsStore } from '../storage/replicant-store.js';

const SETTING = 'selfLinking';

/** Whether users may link external accounts to themselves: at all, and per provider. */
export interface SelfLinkingState {
  readonly enabled: boolean;
  /** The providers it is switched off for. Every other provider allows it. */
  readonly disabledProviders: readonly string[];
}

/**
 * The administrator's switch for self-linking. On by default: a link a user makes for
 * themselves gives them no more than they hold, and making one takes the user's password or a
 * fresh sign-in. What it is switched off for is remembered.
 */
export class SelfLinking {
  readonly #store: Pick<SettingsStore, 'get' | 'set'> | undefined;
  #state: SelfLinkingState = { enabled: true, disabledProviders: [] };

  constructor(store?: Pick<SettingsStore, 'get' | 'set'>) {
    this.#store = store;
  }

  /**
   * Reads what is stored. Something stored that is no state switches it off, to be safe, and
   * so does a store that cannot be read: it is off before the error is passed on, whether or
   * not switching it off can be written.
   */
  async load(): Promise<void> {
    let stored: Json | undefined;
    try {
      stored = await this.#store?.get(SETTING);
    } catch (error) {
      this.#state = { enabled: false, disabledProviders: [] };
      throw error;
    }
    if (stored === undefined) return;
    this.#state = parseState(stored) ?? { enabled: false, disabledProviders: [] };
  }

  get state(): SelfLinkingState {
    return this.#state;
  }

  /** Whether a user may link an account of this provider to themselves. */
  allows(provider: string): boolean {
    return this.#state.enabled && !this.#state.disabledProviders.includes(provider);
  }

  async set(value: unknown): Promise<SelfLinkingState> {
    const state = parseState(value);
    if (!state) {
      throw new MoonCGError(
        'bad_request',
        'Expected { "enabled": true|false, "disabledProviders": ["<provider>", …] }',
      );
    }
    await this.#store?.set(SETTING, { ...state, disabledProviders: [...state.disabledProviders] });
    this.#state = state;
    return state;
  }
}

function parseState(value: unknown): SelfLinkingState | undefined {
  if (!isPlainObject(value as Json)) return undefined;
  const { enabled, disabledProviders = [] } = value as Record<string, unknown>;
  if (typeof enabled !== 'boolean' || !Array.isArray(disabledProviders)) return undefined;
  if (disabledProviders.length > 100) return undefined;
  if (!disabledProviders.every((id) => typeof id === 'string' && id.length <= 100)) {
    return undefined;
  }
  return { enabled, disabledProviders: [...new Set(disabledProviders as string[])].sort() };
}
