import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { messageOf } from './api.js';
import { followBundles } from './live.js';
import { navigation } from './nav.js';
import { useBundles } from './stores/bundles.js';
import { useSession } from './stores/session.js';
import { DialogHost } from './views/DialogHost.js';

/** The frame around every page: who is signed in, where they can go, and the page itself. */
export const App = defineComponent({
  name: 'App',
  setup() {
    const session = useSession();
    const bundles = useBundles();
    const problem = ref('');
    let stop = () => {};

    onMounted(async () => {
      try {
        await Promise.all([session.load(), bundles.refresh()]);
      } catch (error) {
        problem.value = `Could not load the dashboard: ${messageOf(error)}`;
      }
      // The list is asked for again whenever the server says a bundle changed.
      stop = followBundles(
        () => void bundles.refresh().catch(() => {}),
        (message) => {
          problem.value = message;
        },
      );
    });
    onUnmounted(() => stop());

    return () =>
      h('div', { class: 'app' }, [
        h('header', { class: 'top' }, [
          h('span', { class: 'brand' }, 'MoonCG'),
          h(
            'nav',
            { 'aria-label': 'Main' },
            navigation(session.permissions, bundles.workspaces).map((item) =>
              h(RouterLink, { key: item.to, to: item.to }, () => item.label),
            ),
          ),
          h('span', { class: 'user', 'data-user-name': '' }, session.name),
          h(
            'button',
            { type: 'button', id: 'logout', onClick: () => session.logout() },
            'Sign out',
          ),
        ]),
        problem.value ? h('p', { class: 'problem', role: 'alert' }, problem.value) : null,
        h('main', h(RouterView)),
        h(DialogHost),
      ]);
  },
});
