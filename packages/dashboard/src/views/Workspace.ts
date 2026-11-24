import { defineComponent, h, watch } from 'vue';
import type { Placement } from '../layout.js';
import { useBundles, type WorkspacePanel } from '../stores/bundles.js';
import { useLayout } from '../stores/layout.js';
import { PANEL_BUNDLE_ATTRIBUTE } from './DialogHost.js';
import { counted, pageHead } from './parts.js';

const BUTTONS = [
  ['left', 'Move towards the start', '←'],
  ['right', 'Move towards the end', '→'],
  ['narrower', 'Narrower', '−w'],
  ['wider', 'Wider', '+w'],
  ['shorter', 'Shorter', '−h'],
  ['taller', 'Taller', '+h'],
] as const;
type Action = (typeof BUTTONS)[number][0];

/** The panels of one workspace, each framed from its own URL, in the user's layout. */
export const WorkspaceView = defineComponent({
  name: 'WorkspaceView',
  props: { workspace: { type: String, required: true } },
  setup(props) {
    const bundles = useBundles();
    const layout = useLayout();
    const ids = () =>
      bundles
        .panelsOf(props.workspace)
        .map((panel) => panel.id)
        .join();
    // Loaded again when the workspace changes or its panels do, such as after a reload.
    watch(
      () => [props.workspace, ids()],
      () => void layout.load(props.workspace, bundles.panelsOf(props.workspace)),
      { immediate: true },
    );
    const act = (id: string, action: Action) => {
      const { workspace } = props;
      if (action === 'left') return layout.move(workspace, id, -1);
      if (action === 'right') return layout.move(workspace, id, 1);
      if (action === 'narrower') return layout.resize(workspace, id, -1, 0);
      if (action === 'wider') return layout.resize(workspace, id, 1, 0);
      return layout.resize(workspace, id, 0, action === 'shorter' ? -1 : 1);
    };

    const frame = ({ id, w, h: height }: Placement, panel: WorkspacePanel | undefined) =>
      h('section', { key: id, class: ['panel', `w-${w}`, `h-${height}`], 'data-panel': id }, [
        h('header', [
          h('h2', panel?.title),
          h(
            'span',
            { class: 'tools' },
            BUTTONS.map(([action, label, sign]) =>
              h(
                'button',
                {
                  type: 'button',
                  title: label,
                  'aria-label': `${label}: ${panel?.title}`,
                  'data-action': action,
                  onClick: () => act(id, action),
                },
                sign,
              ),
            ),
          ),
        ]),
        // The attribute is how the dialog host knows which bundle a panel's window belongs to.
        h('iframe', {
          src: panel?.url,
          title: panel?.title,
          [PANEL_BUNDLE_ATTRIBUTE]: panel?.bundle,
        }),
      ]);

    /**
     * One line for each panel the layout knows that is missing because its bundle does not
     * run. A panel is named by its id: the list has no title for what it does not serve. A
     * panel of a bundle that runs, or of one the user is not shown, is gone, not hidden.
     */
    const hidden = () =>
      layout.absentOf(props.workspace).flatMap((id) => {
        const [name = '', panel = ''] = id.split(':');
        const bundle = bundles.list.find((item) => item.name === name);
        if (!bundle || bundle.state === 'running') return [];
        return [
          h(
            'p',
            { key: id, class: 'muted hidden-panel', 'data-hidden-panel': id },
            `"${panel}" is hidden: the bundle ${bundle.name} is ${bundle.state}.`,
          ),
        ];
      });

    return () => {
      const panels = new Map(bundles.panelsOf(props.workspace).map((panel) => [panel.id, panel]));
      const placed = layout.of(props.workspace).filter((item) => panels.has(item.id));
      const head = pageHead(props.workspace, {
        badge:
          placed.length > 0 ? h('span', { class: 'badge' }, counted(placed.length, 'panel')) : null,
        description:
          'Arrange panels with ← → and resize them with −w +w −h +h. The layout is saved for you on the server.',
      });
      if (placed.length === 0) {
        return h('div', [
          head,
          h('p', { class: 'empty' }, 'This workspace has no panel you may use.'),
          ...hidden(),
        ]);
      }
      return h('div', [
        head,
        layout.problem ? h('p', { class: 'problem', role: 'alert' }, layout.problem) : null,
        h(
          'div',
          { class: 'grid' },
          placed.map((item) => frame(item, panels.get(item.id))),
        ),
        ...hidden(),
      ]);
    };
  },
});
