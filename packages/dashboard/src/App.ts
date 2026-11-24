import type { ConnectionStatus } from '@mooncg/sdk/client';
import { defineComponent, h, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import logoUrl from '../../server/public/logo-mark.svg';
import { messageOf } from './api.js';
import { followBundles, live } from './live.js';
import { grouped, type NavItem, navigation } from './nav.js';
import { useBundles } from './stores/bundles.js';
import { useInstances } from './stores/instances.js';
import { useLogs } from './stores/logs.js';
import { useSession } from './stores/session.js';
import { DialogHost } from './views/DialogHost.js';

const CONNECTION: Readonly<Record<ConnectionStatus, string>> = {
  live: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
};

/** The frame around every page: who is signed in, where they can go, and the page itself. */
export const App = defineComponent({
  name: 'App',
  setup() {
    const session = useSession();
    const bundles = useBundles();
    const instances = useInstances();
    const logs = useLogs();
    const problem = ref('');
    const connection = ref<ConnectionStatus>('reconnecting');
    /** What a screen reader is told: a change of the connection, not where it stood at first. */
    const announced = ref('');
    let told = false;
    let wasLive = false;
    let stop = () => {};
    let stopLogs = () => {};

    const stopStatus = live.status((status) => {
      // The first call says where the connection stands as the page loads, and the first
      // `live` after it is the page connecting: neither is news.
      const news = told && (status !== 'live' || wasLive);
      if (status === 'live') wasLive = true;
      told = true;
      connection.value = status;
      if (news) announced.value = CONNECTION[status];
    });
    // For the count of graphics that are open.
    const stopInstances = instances.follow();
    // The log is followed for its count, by whoever may read it. Nobody else even asks.
    watch(
      () => session.can('system:logs.view'),
      (may) => {
        stopLogs();
        stopLogs = may ? logs.follow() : () => {};
      },
      { immediate: true },
    );

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
    onUnmounted(() => {
      stop();
      stopStatus();
      stopInstances();
      stopLogs();
    });

    const entries = () =>
      navigation(session.permissions, bundles.workspaces, {
        panels: Object.fromEntries(
          bundles.workspaces.map((name) => [name, bundles.panelsOf(name).length]),
        ),
        failedBundles: bundles.list.filter((bundle) => bundle.state === 'failed').length,
        openGraphics: instances.open,
        unseenLogs: logs.unseen,
      });

    const link = (item: NavItem) =>
      h(
        RouterLink,
        {
          key: item.to,
          to: item.to,
          class: 'nav-item',
          // The number alone says nothing to someone who cannot see where it stands.
          ...(item.hint === undefined ? {} : { 'aria-label': `${item.label}, ${item.hint}` }),
        },
        () => [
          h('span', item.label),
          item.count === undefined
            ? null
            : h('span', { class: ['count', item.tone], title: item.hint }, String(item.count)),
        ],
      );

    return () =>
      h('div', { class: 'app shell' }, [
        h('aside', { class: 'sidebar' }, [
          h('div', { class: 'sidebar-brand' }, [
            h('img', { src: logoUrl, alt: '' }),
            h('span', { class: 'brand' }, 'MoonCG'),
          ]),
          h(
            'nav',
            { 'aria-label': 'Main' },
            grouped(entries()).map(({ group, items }) =>
              h(
                'div',
                {
                  key: group,
                  role: 'group',
                  'aria-labelledby': `nav-${group}`,
                  'data-nav-group': group,
                },
                [
                  h('div', { class: 'nav-label', id: `nav-${group}` }, group),
                  h('div', { class: 'nav-group' }, items.map(link)),
                ],
              ),
            ),
          ),
          h('div', { class: 'sidebar-foot' }, [
            h('div', { class: 'conn', 'data-status': connection.value }, [
              h('span', { class: 'dot' }),
              CONNECTION[connection.value],
              h('code', location.host),
            ]),
            h('span', { class: 'visually-hidden', role: 'status' }, announced.value),
            h('div', { class: 'me' }, [
              h(
                'span',
                { class: 'avatar', 'aria-hidden': 'true' },
                session.name.charAt(0).toUpperCase(),
              ),
              h('span', { class: 'user', 'data-user-name': '' }, session.name),
              h(
                'button',
                {
                  type: 'button',
                  id: 'logout',
                  class: 'small ghost',
                  onClick: () => session.logout(),
                },
                'Sign out',
              ),
            ]),
          ]),
        ]),
        h('div', { class: 'content' }, [
          problem.value ? h('p', { class: 'problem', role: 'alert' }, problem.value) : null,
          h('main', h(RouterView)),
        ]),
        h(DialogHost),
      ]);
  },
});
