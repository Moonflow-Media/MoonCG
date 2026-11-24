import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue';
import { LOG_LEVELS, type LogLevel, useLogs } from '../stores/logs.js';
import { pageHead, segmented } from './parts.js';

/** The latest lines of the server log, followed while the page is open. */
export const LogsView = defineComponent({
  name: 'LogsView',
  setup() {
    const logs = useLogs();
    /** Lines below this level are hidden. */
    const level = ref<LogLevel>('info');
    let leave = () => {};
    // While the page is open, what is logged counts as seen by this user.
    onMounted(() => {
      leave = logs.visit();
    });
    onUnmounted(() => leave());

    /** The lines at a level or above it. */
    const from = (name: LogLevel) => {
      const least = LOG_LEVELS.indexOf(name);
      return logs.entries.filter((entry) => LOG_LEVELS.indexOf(entry.level) >= least);
    };

    return () => {
      const shown = from(level.value);
      return h('div', [
        pageHead('Logs', {
          description: 'The server log, updated every 2 seconds.',
          // Each choice says how many lines it shows: its own level and the ones above.
          actions: segmented<LogLevel>({
            label: 'Show from level',
            value: level.value,
            choices: LOG_LEVELS.map((name) => ({
              value: name,
              label: name,
              count: from(name).length,
            })),
            onChange: (value) => {
              level.value = value;
            },
          }),
        }),
        logs.problem ? h('p', { class: 'problem', role: 'alert' }, logs.problem) : null,
        shown.length === 0 && !logs.problem ? h('p', { class: 'empty' }, 'Nothing logged.') : null,
        shown.length > 0
          ? h(
              'section',
              { class: 'card' },
              h(
                'div',
                { class: 'card-body' },
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
              ),
            )
          : null,
      ]);
    };
  },
});
