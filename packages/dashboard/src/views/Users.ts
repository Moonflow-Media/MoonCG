import { defineComponent, h, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { field, part, sure, useActions } from './admin.js';
import { pageHead } from './parts.js';

interface User {
  readonly id: string;
  readonly name: string;
  readonly disabled: boolean;
  readonly roles: readonly string[];
}

/** Users with their roles: create, enable and disable, assign roles, reset passwords, delete. */
export const UsersView = defineComponent({
  name: 'UsersView',
  setup() {
    const users = ref<User[]>([]);
    const roles = ref<string[]>([]);
    /** The roles ticked in the form for a new user. */
    const chosen = ref<string[]>([]);
    const { run, send, alert } = useActions(async () => {
      users.value = (await api.request<{ users: User[] }>('GET', '/api/v1/users')).users;
      const listed = await api.request<{ roles: { name: string }[] }>('GET', '/api/v1/roles');
      roles.value = listed.roles.map((role) => role.name);
    });
    onMounted(() => run(async () => {}));

    const create = async (event: Event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const done = await send('POST', '/api/v1/users', {
        name: field(event, 'name'),
        password: field(event, 'password'),
        roles: chosen.value,
      });
      if (done) {
        form.reset();
        chosen.value = [];
      }
    };
    const setRole = (user: User, role: string, on: boolean) =>
      send(on ? 'PUT' : 'DELETE', `/api/v1/users/${part(user.id)}/roles/${part(role)}`);
    const reset = async (event: Event, user: User) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const password = field(event, 'new-password');
      if (await send('PUT', `/api/v1/users/${part(user.id)}/password`, { password })) form.reset();
    };
    const roleBoxes = (
      has: (role: string) => boolean,
      change: (role: string, on: boolean) => void,
    ) =>
      roles.value.map((role) =>
        h('label', { key: role, class: 'check' }, [
          h('input', {
            type: 'checkbox',
            'data-role': role,
            checked: has(role),
            onChange: (event: Event) => change(role, (event.target as HTMLInputElement).checked),
          }),
          ` ${role}`,
        ]),
      );

    return () =>
      h('div', [
        pageHead('Users'),
        alert(),
        h('div', { class: 'split' }, [
          h(
            'section',
            { class: 'card' },
            h(
              'ul',
              { class: 'rows' },
              users.value.map((user) =>
                h('li', { key: user.id, 'data-user': user.name }, [
                  h('strong', user.name),
                  user.disabled ? h('span', { class: 'state disabled' }, 'disabled') : null,
                  h(
                    'span',
                    { class: 'checks' },
                    roleBoxes(
                      (role) => user.roles.includes(role),
                      (role, on) => setRole(user, role, on),
                    ),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'small',
                      'data-action': 'toggle',
                      onClick: () =>
                        send('PATCH', `/api/v1/users/${part(user.id)}`, {
                          disabled: !user.disabled,
                        }),
                    },
                    user.disabled ? 'Enable' : 'Disable',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'small danger',
                      'data-action': 'delete',
                      onClick: () =>
                        sure(`Delete the user "${user.name}"? Their sessions and tokens go too.`) &&
                        send('DELETE', `/api/v1/users/${part(user.id)}`),
                    },
                    'Delete',
                  ),
                  h('form', { class: 'inline', onSubmit: (event: Event) => reset(event, user) }, [
                    h('input', {
                      name: 'new-password',
                      type: 'password',
                      autocomplete: 'new-password',
                      minlength: 8,
                      required: true,
                      placeholder: 'New password',
                      'aria-label': `New password for ${user.name}`,
                    }),
                    h('button', { type: 'submit', class: 'small' }, 'Set password'),
                  ]),
                ]),
              ),
            ),
          ),
          h('section', { class: 'card' }, [
            h('div', { class: 'card-head' }, h('h2', 'New user')),
            h(
              'div',
              { class: 'card-body' },
              h('form', { class: 'stack', 'data-form': 'create', onSubmit: create }, [
                h('label', [
                  'Name ',
                  h('input', { name: 'name', required: true, autocomplete: 'off' }),
                ]),
                h('label', [
                  'Password (at least 8 characters) ',
                  h('input', {
                    name: 'password',
                    type: 'password',
                    autocomplete: 'new-password',
                    minlength: 8,
                    required: true,
                  }),
                ]),
                h(
                  'span',
                  { class: 'checks' },
                  roleBoxes(
                    (role) => chosen.value.includes(role),
                    (role, on) => {
                      chosen.value = on
                        ? [...chosen.value, role]
                        : chosen.value.filter((name) => name !== role);
                    },
                  ),
                ),
                h('button', { type: 'submit', class: 'primary' }, 'Create user'),
              ]),
            ),
          ]),
        ]),
      ]);
  },
});
