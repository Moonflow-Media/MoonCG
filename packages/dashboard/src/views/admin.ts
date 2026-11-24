import { h, ref } from 'vue';
import { api, messageOf } from '../api.js';

/**
 * What the admin pages share: do something on the server, show why it was refused if it was,
 * and load the list again either way, so the page shows what the server has.
 */
export function useActions(reload: () => Promise<void>) {
  const problem = ref('');
  async function run(work: () => Promise<unknown>): Promise<boolean> {
    problem.value = '';
    let done = true;
    try {
      await work();
    } catch (error) {
      problem.value = messageOf(error);
      done = false;
    }
    await reload().catch((error) => {
      problem.value ||= messageOf(error);
    });
    return done;
  }
  const send = (method: string, path: string, body?: unknown) =>
    run(() => api.request(method, path, body));
  const alert = () =>
    problem.value ? h('p', { class: 'problem', role: 'alert' }, problem.value) : null;
  return { problem, run, send, alert };
}

/** Asks before something is deleted for good. */
export const sure = (question: string) => globalThis.confirm(question);

/** The value of a form field by name. */
export function field(event: Event, name: string): string {
  const input = (event.currentTarget as HTMLFormElement).elements.namedItem(name);
  return (input as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '';
}

/** A path segment, percent-encoded. */
export const part = encodeURIComponent;
