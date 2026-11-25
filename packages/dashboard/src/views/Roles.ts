import { defineComponent, h, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { field, part, sure, useActions } from './admin.js';
import { pageHead } from './parts.js';

interface Role {
  readonly name: string;
  readonly builtin: boolean;
  readonly grants: readonly string[];
}

/** A system permission there is to grant: one of the server, or one a module defined. */
interface Known {
  readonly permission: string;
  readonly description: string;
  /** The module that defined it. */
  readonly module?: string;
}

/** Roles and what each grants. Built-in roles can be changed but not deleted. */
export const RolesView = defineComponent({
  name: 'RolesView',
  setup() {
    const roles = ref<Role[]>([]);
    const known = ref<Known[]>([]);
    const { run, send, alert } = useActions(async () => {
      roles.value = (await api.request<{ roles: Role[] }>('GET', '/api/v1/roles')).roles;
      // A help, not a need: the page works without the list.
      const listed = await api
        .request<{ permissions: Known[] } | undefined>('GET', '/api/v1/permissions')
        .catch(() => undefined);
      known.value = listed?.permissions ?? [];
    });
    onMounted(() => run(async () => {}));

    const grant = async (event: Event, role: Role) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const permission = field(event, 'grant').trim();
      if (await send('POST', `/api/v1/roles/${part(role.name)}/grants`, { permission })) {
        form.reset();
      }
    };
    const create = async (event: Event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const name = field(event, 'name').trim();
      if (await send('POST', '/api/v1/roles', { name, grants: [] })) form.reset();
    };

    const card = (role: Role) =>
      h('section', { key: role.name, class: 'card', 'data-role': role.name }, [
        h('div', { class: 'card-head' }, [
          h('h2', role.name),
          role.builtin ? h('span', { class: 'badge' }, 'built in') : null,
          role.builtin
            ? null
            : h(
                'div',
                { class: 'card-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'small danger',
                    'data-action': 'delete',
                    onClick: () =>
                      sure(`Delete the role "${role.name}"? Users who have it lose it.`) &&
                      send('DELETE', `/api/v1/roles/${part(role.name)}`),
                  },
                  'Delete role',
                ),
              ),
        ]),
        h('div', { class: 'card-body' }, [
          h(
            'ul',
            { class: 'grants' },
            role.grants.map((permission) =>
              h('li', { key: permission }, [
                h('code', permission),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'small ghost',
                    'data-action': 'revoke',
                    'aria-label': `Remove ${permission} from ${role.name}`,
                    onClick: () =>
                      send('DELETE', `/api/v1/roles/${part(role.name)}/grants/${part(permission)}`),
                  },
                  'Remove',
                ),
              ]),
            ),
          ),
          h('form', { class: 'inline', onSubmit: (event: Event) => grant(event, role) }, [
            h('input', {
              name: 'grant',
              required: true,
              placeholder: 'bundle:name:permission',
              'aria-label': `Grant to add to ${role.name}`,
            }),
            h('button', { type: 'submit', class: 'small' }, 'Add grant'),
          ]),
        ]),
      ]);

    return () =>
      h('div', [
        pageHead('Roles', {
          description:
            'A grant is "*", "system:<permission>" or "bundle:<name>:<permission>"; "*" may stand for a part. You can only give and take what you hold yourself.',
        }),
        alert(),
        h('div', { class: 'cards-2' }, [
          ...roles.value.map(card),
          h('section', { class: 'card' }, [
            h('div', { class: 'card-head' }, h('h2', 'New role')),
            h(
              'div',
              { class: 'card-body' },
              h('form', { class: 'stack', 'data-form': 'create', onSubmit: create }, [
                h('label', [
                  'Name (lowercase letters, digits, dashes) ',
                  h('input', { name: 'name', required: true, autocomplete: 'off' }),
                ]),
                h('button', { type: 'submit', class: 'primary' }, 'Create role'),
              ]),
            ),
          ]),
          known.value.length === 0
            ? null
            : h('section', { class: 'card', 'data-help': 'permissions' }, [
                h('div', { class: 'card-head' }, h('h2', 'System permissions')),
                h(
                  'div',
                  { class: 'card-body' },
                  h(
                    'ul',
                    { class: 'grants' },
                    known.value.map(({ permission, description, module }) =>
                      h('li', { key: permission, 'data-permission': permission }, [
                        h('code', permission),
                        h(
                          'span',
                          { class: 'muted' },
                          module === undefined ? description : `${description} (module ${module})`,
                        ),
                      ]),
                    ),
                  ),
                ),
              ]),
        ]),
      ]);
  },
});
