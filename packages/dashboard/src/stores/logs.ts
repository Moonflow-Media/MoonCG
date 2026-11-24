import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { api, messageOf } from '../api.js';
import { useSession } from './session.js';

export const LOG_LEVELS = ['info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEntry {
  readonly id: number;
  readonly time: string;
  readonly level: LogLevel;
  readonly text: string;
}

/** How often new lines are asked for. */
const POLL_MS = 2000;
/** How many lines are kept; older ones scroll out. */
const MAX_LINES = 1000;
/** Where a browser keeps, per user, up to when that user has seen the log. */
const SEEN_KEY = 'mooncg.logs.seen.';

/**
 * The latest lines of the server log, asked for again every two seconds while someone
 * follows it: the log page, and the shell for the count in the navigation. Only whoever
 * holds `system:logs.view` is to follow it; the server refuses everyone else.
 */
export const useLogs = defineStore('logs', () => {
  const session = useSession();
  const entries = ref<LogEntry[]>([]);
  const problem = ref('');
  /**
   * The time of the newest line the user has had on the log page. Line ids start again with
   * the server, times do not, so this is a time.
   */
  const seen = ref('');
  let last = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let followers = 0;
  let visitors = 0;
  /** A request is under way. The next one waits for the following round of the clock. */
  let loading = false;

  // Kept in this browser under the user's id. A browser that keeps nothing counts from the
  // start of what the server still has, every time.
  const key = () => {
    const id = session.me?.user.id;
    return id === undefined ? undefined : `${SEEN_KEY}${id}`;
  };
  const remember = () => {
    const name = key();
    if (name === undefined || seen.value === '') return;
    try {
      localStorage.setItem(name, seen.value);
    } catch {
      // Storage is off or full: the mark lasts as long as the page.
    }
  };
  watch(
    key,
    (name) => {
      if (name === undefined) return;
      let stored = '';
      try {
        stored = localStorage.getItem(name) ?? '';
      } catch {
        // As above.
      }
      if (stored > seen.value) seen.value = stored;
      else remember();
    },
    { immediate: true },
  );

  /** Everything there is now has been seen. */
  const mark = () => {
    const newest = entries.value.at(-1)?.time;
    if (newest === undefined || newest <= seen.value) return;
    seen.value = newest;
    remember();
  };

  /** Asks for what is new, unless the answer to the last such question is still awaited. */
  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      await fetchNew();
    } finally {
      loading = false;
    }
  }

  async function fetchNew(): Promise<void> {
    const asked = last;
    try {
      const answer = await api.request<{ entries: LogEntry[]; last: number }>(
        'GET',
        `/api/v1/logs?after=${asked}`,
      );
      // An answer to a question that is no longer the one to ask would add lines twice.
      if (asked !== last) return;
      if (answer.last < last) {
        // The server knows fewer lines than this page has seen: it was restarted and
        // counts from one again. What is shown is of the run before; start over.
        last = 0;
        entries.value = [];
        return fetchNew();
      }
      last = answer.last;
      entries.value = [...entries.value, ...answer.entries].slice(-MAX_LINES);
      problem.value = '';
      if (visitors > 0) mark();
    } catch (error) {
      problem.value = `Could not load the log: ${messageOf(error)}`;
    }
  }

  /** The warnings and errors logged since the user last had the log page open. */
  const unseen = computed(
    () => entries.value.filter((entry) => entry.level !== 'info' && entry.time > seen.value).length,
  );

  /** Keeps the log up to date until the returned function is called. */
  function follow(): () => void {
    if (++followers === 1) {
      void load();
      timer = setInterval(() => void load(), POLL_MS);
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (--followers === 0) clearInterval(timer);
    };
  }

  /** As `follow`, for the log page: while it is open, what is logged counts as seen. */
  function visit(): () => void {
    visitors++;
    mark();
    const stop = follow();
    let left = false;
    return () => {
      if (left) return;
      left = true;
      visitors--;
      stop();
    };
  }

  return { entries, problem, unseen, follow, visit };
});
