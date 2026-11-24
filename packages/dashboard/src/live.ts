import { type ConnectionStatus, createClient, type MoonCGClient } from '@mooncg/sdk/client';

let shared: MoonCGClient | undefined;

/** The dashboard's one connection. It is no bundle: it connects under the server's own name. */
function client(): MoonCGClient {
  shared ??= createClient({ bundle: 'system' });
  return shared;
}

/**
 * What the dashboard follows live. `follow` and `status` are properties so that tests can put
 * their own in their place.
 */
export const live = {
  /**
   * Calls `onValue` with the value of a replicant, now and whenever it changes. `name` is
   * `bundle:name`. Returns the function that stops it. A replicant the user may not read, or
   * that is gone, simply never calls.
   */
  follow<T>(name: string, onValue: (value: T) => void): () => void {
    try {
      return client()
        .replicant<T>(name)
        .subscribe((value) => onValue(value as T));
    } catch {
      return () => {};
    }
  },

  /**
   * Calls `onStatus` with how the connection stands, now and whenever that changes. Returns
   * the function that stops it. Where no connection can be made at all, it is `offline`.
   */
  status(onStatus: (status: ConnectionStatus) => void): () => void {
    try {
      const connection = client();
      onStatus(connection.status);
      return connection.onStatusChange(onStatus);
    } catch {
      onStatus('offline');
      return () => {};
    }
  },
};

/**
 * Calls `onChange` whenever a bundle changes on the server. It follows the replicant
 * `system:revision`, a counter that tells nothing but that something changed. Returns the
 * function that stops following.
 */
export function followBundles(onChange: () => void, onProblem: (message: string) => void) {
  try {
    const revision = client().replicant<{ bundles: number }>('revision');
    let first = true;
    return revision.subscribe(() => {
      // The first value is the state at the time of connecting, which was just loaded.
      if (first) first = false;
      else onChange();
    });
  } catch {
    onProblem('Live updates are off. Reload the page to see changes.');
    return () => {};
  }
}
