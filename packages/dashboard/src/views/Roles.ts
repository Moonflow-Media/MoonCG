import { defineComponent, h, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { field, part, sure, useActions } from './admin.js';

interface Role {
  readonly name: string;
  readonly builtin: boolean;
  readonly grants: readonly string[];
}

/** Roles and what each grants. Built-in roles can be changed but not deleted. */
export const RolesView = defineComponent({
  name: 'RolesView',
  setup() {
    const roles = ref<Role[]>([]);
    const { run, send, alert } = useActions(async () => {
      roles.value = (await api.request<{ roles: Role[] }>('GET', '/api/v1/roles')).roles;
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

    return () =>
      h('div', [
        h('h1', 'Roles'),
        h(
          'p',
          { class: 'muted' },
          'A grant is "*", "system:<permission>" or "bundle:<name>:<permission>"; "*" may stand for a part. You can only give and take what you hold yourself.',
        ),
        alert(),
        h(
          'ul',
          { class: 'rows' },
          roles.value.map((role) =>
            h('li', { key: role.name, 'data-role': role.name }, [
              h('strong', role.name),
              role.builtin ? h('span', { class: 'muted' }, ' built in ') : null,
              role.builtin
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      'data-action': 'delete',
                      onClick: () =>
                        sure(`Delete the role "${role.name}"? Users who have it lose it.`) &&
                        send('DELETE', `/api/v1/roles/${part(role.name)}`),
                    },
                    'Delete role',
                  ),
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
                        'data-action': 'revoke',
                        'aria-label': `Remove ${permission} from ${role.name}`,
                        onClick: () =>
                          send(
                            'DELETE',
                            `/api/v1/roles/${part(role.name)}/grants/${part(permission)}`,
                          ),
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
                h('button', { type: 'submit' }, 'Add grant'),
              ]),
            ]),
          ),
        ),
        h('h2', 'New role'),
        h('form', { class: 'stack', 'data-form': 'create', onSubmit: create }, [
          h('label', [
            'Name (lowercase letters, digits, dashes) ',
            h('input', { name: 'name', required: true, autocomplete: 'off' }),
          ]),
          h('button', { type: 'submit' }, 'Create role'),
        ]),
      ]);
  },
});
