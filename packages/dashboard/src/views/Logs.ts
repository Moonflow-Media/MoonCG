import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue';
import { api, messageOf } from '../api.js';

interface LogEntry {
  readonly id: number;
  readonly time: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
}

/** How often the page asks for new lines. */
const POLL_MS = 2000;
/** How many lines the page keeps; older ones scroll out. */
const MAX_LINES = 1000;
const LEVELS = ['info', 'warn', 'error'] as const;

/** The latest lines of the server log, followed while the page is open. */
export const LogsView = defineComponent({
  name: 'LogsView',
  setup() {
    const entries = ref<LogEntry[]>([]);
    /** Lines below this level are hidden. */
    const level = ref<LogEntry['level']>('info');
    const problem = ref('');
    let last = 0;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function load(): Promise<void> {
      try {
        const answer = await api.request<{ entries: LogEntry[]; last: number }>(
          'GET',
          `/api/v1/logs?after=${last}`,
        );
        if (answer.last < last) {
          // The server knows fewer lines than this page has seen: it was restarted and
          // counts from one again. What is shown is of the run before; start over.
          last = 0;
          entries.value = [];
          return load();
        }
        last = answer.last;
        entries.value = [...entries.value, ...answer.entries].slice(-MAX_LINES);
        problem.value = '';
      } catch (error) {
        problem.value = `Could not load the log: ${messageOf(error)}`;
      }
    }
    onMounted(() => {
      void load();
      timer = setInterval(() => void load(), POLL_MS);
    });
    onUnmounted(() => clearInterval(timer));

    return () => {
      const from = LEVELS.indexOf(level.value);
      const shown = entries.value.filter((entry) => LEVELS.indexOf(entry.level) >= from);
      return h('div', [
        h('h1', 'Logs'),
        h('label', [
          'Show from level ',
          h(
            'select',
            {
              value: level.value,
              onChange: (event: Event) => {
                level.value = (event.target as HTMLSelectElement).value as LogEntry['level'];
              },
            },
            LEVELS.map((name) => h('option', { value: name }, name)),
          ),
        ]),
        problem.value ? h('p', { class: 'problem', role: 'alert' }, problem.value) : null,
        shown.length === 0 && !problem.value ? h('p', { class: 'empty' }, 'Nothing logged.') : null,
        h(
          'ol',
          { class: 'log' },
          shown.map((entry) =>
            h('li', { key: entry.id, 'data-log': entry.id, class: entry.level }, [
              h('time', { datetime: entry.time }, entry.time.slice(11, 19)),
              h('span', { class: 'level' }, ` ${entry.level} `),
              entry.text,
            ]),
          ),
        ),
      ]);
    };
  },
});
