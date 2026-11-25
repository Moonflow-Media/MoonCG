import { defineComponent, h, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { field, part, sure, useActions } from './admin.js';
import { pageHead } from './parts.js';

interface User {
  readonly id: string;
  readonly name: string;
  readonly disabled: boolean;
  readonly roles: readonly string[];
  /** The user dev mode created to act as. It cannot be changed, only deleted. */
  readonly devMode?: boolean;
}

/** A link of a user to an account at an external provider. */
interface Identity {
  readonly userId: string;
  readonly provider: string;
  readonly subject: string;
  /** Who vouches for the account, such as an issuer. Missing while the link is bound to none. */
  readonly realm?: string;
}

/** An account that tried to sign in and belongs to no user. */
interface Unlinked {
  readonly provider: string;
  readonly subject: string;
  /** The realm the account came from, which a link to it is made for. */
  readonly realm?: string;
  readonly name?: string;
  readonly at: string;
}

interface Identities {
  readonly identities: readonly Identity[];
  readonly providers: readonly { readonly id: string; readonly name: string }[];
  readonly unlinked: readonly Unlinked[];
}

const NO_IDENTITIES: Identities = { identities: [], providers: [], unlinked: [] };

/**
 * Users with their roles: create, enable and disable, assign roles, reset passwords, delete,
 * and say which external accounts each can sign in with.
 */
export const UsersView = defineComponent({
  name: 'UsersView',
  setup() {
    const users = ref<User[]>([]);
    const roles = ref<string[]>([]);
    const external = ref<Identities>(NO_IDENTITIES);
    /** Whether users may link accounts to themselves; unknown on a server without modules. */
    const selfLinking = ref<{ enabled: boolean; disabledProviders: string[] }>();
    /** The user chosen for each account that waits to be linked, by provider and subject. */
    const chosenUser = ref<Record<string, string>>({});
    /** The roles ticked in the form for a new user. */
    const chosen = ref<string[]>([]);
    const { run, send, alert } = useActions(async () => {
      users.value = (await api.request<{ users: User[] }>('GET', '/api/v1/users')).users;
      const listed = await api.request<{ roles: { name: string }[] }>('GET', '/api/v1/roles');
      roles.value = listed.roles.map((role) => role.name);
      // A server without modules has no external accounts, and no list of them.
      const linked = await api
        .request<Identities | undefined>('GET', '/api/v1/identities')
        .catch(() => undefined);
      external.value = linked ?? NO_IDENTITIES;
      selfLinking.value = await api
        .request<{ enabled: boolean; disabledProviders: string[] }>('GET', '/api/v1/self-linking')
        .catch(() => undefined);
    });
    /** Switches self-linking for all providers, or for one. */
    const switchSelfLinking = (provider: string | undefined, on: boolean) => {
      const state = selfLinking.value;
      if (!state) return;
      const disabledProviders =
        provider === undefined
          ? state.disabledProviders
          : on
            ? state.disabledProviders.filter((id) => id !== provider)
            : [...state.disabledProviders, provider];
      return send('PUT', '/api/v1/self-linking', {
        enabled: provider === undefined ? on : state.enabled,
        disabledProviders,
      });
    };
    const selfLinkingCard = () => {
      const state = selfLinking.value;
      const { providers } = external.value;
      if (!state || providers.length === 0) return null;
      const box = (label: string, checked: boolean, change: (on: boolean) => void, key: string) =>
        h('label', { class: 'check', key }, [
          h('input', {
            type: 'checkbox',
            name: key,
            checked,
            onChange: (event: Event) => change((event.target as HTMLInputElement).checked),
          }),
          ` ${label}`,
        ]);
      return h('section', { class: 'card', 'data-self-linking': '' }, [
        h('div', { class: 'card-head' }, h('h2', 'Self-linking')),
        h('div', { class: 'card-body stack' }, [
          h(
            'p',
            { class: 'field-note' },
            'Whether users may link an account of a provider to themselves on their Account page, after their password or a fresh sign-in.',
          ),
          box(
            'Users may link accounts',
            state.enabled,
            (on) => switchSelfLinking(undefined, on),
            'self-linking',
          ),
          ...providers.map(({ id, name }) =>
            box(
              name,
              !state.disabledProviders.includes(id),
              (on) => switchSelfLinking(id, on),
              `self-linking-${id}`,
            ),
          ),
        ]),
      ]);
    };
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

    const providerName = (id: string) =>
      external.value.providers.find((provider) => provider.id === id)?.name ?? id;
    const link = (userId: string, provider: string, subject: string, realm?: string) =>
      send('PUT', `/api/v1/users/${part(userId)}/identities/${part(provider)}`, {
        subject,
        ...(realm === undefined ? {} : { realm }),
      });
    /** Who vouches for an account. It decides whose account a subject is, so it is shown. */
    const realmOf = (realm: string | undefined) =>
      realm === undefined
        ? null
        : h(
            'span',
            {
              class: 'muted',
              'data-realm': '',
              title: 'The realm of the account: who vouches for it, such as the issuer.',
            },
            realm,
          );
    const linkFrom = async (event: Event, user: User) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const subject = field(event, 'subject').trim();
      if (await link(user.id, field(event, 'provider'), subject)) form.reset();
    };
    /** The accounts a user can sign in with, and a way to add one where there is a provider. */
    const identities = (user: User) => {
      const linked = external.value.identities.filter((identity) => identity.userId === user.id);
      const { providers } = external.value;
      if (linked.length === 0 && providers.length === 0) return null;
      return h('div', { class: 'identities' }, [
        ...linked.map(({ provider, subject, realm }) =>
          h(
            'span',
            { key: `${provider}:${subject}`, class: 'identity', 'data-identity': provider },
            [
              `${providerName(provider)}: `,
              h('code', subject),
              ' ',
              realmOf(realm),
              realm === undefined ? null : ' ',
              h(
                'button',
                {
                  type: 'button',
                  class: 'small ghost',
                  'data-action': 'unlink',
                  'aria-label': `Unlink the ${providerName(provider)} account ${subject} from ${user.name}`,
                  onClick: () =>
                    sure(
                      `Unlink the ${providerName(provider)} account from "${user.name}"? They are signed out everywhere.`,
                    ) &&
                    send(
                      'DELETE',
                      `/api/v1/users/${part(user.id)}/identities/${part(provider)}/${part(subject)}`,
                    ),
                },
                'Unlink',
              ),
            ],
          ),
        ),
        providers.length === 0
          ? null
          : h(
              'form',
              {
                class: 'inline',
                'data-form': 'link',
                onSubmit: (event: Event) => linkFrom(event, user),
              },
              [
                h(
                  'select',
                  { name: 'provider', 'aria-label': `Provider of the account for ${user.name}` },
                  providers.map(({ id, name }) => h('option', { key: id, value: id }, name)),
                ),
                h('input', {
                  name: 'subject',
                  required: true,
                  autocomplete: 'off',
                  placeholder: 'Account id at the provider',
                  'aria-label': `Id of the account to link to ${user.name}`,
                }),
                h('button', { type: 'submit', class: 'small' }, 'Link account'),
              ],
            ),
      ]);
    };
    /** The accounts that tried to sign in and belong to nobody: each can be given to a user. */
    const unlinked = () => {
      const attempts = external.value.unlinked;
      if (attempts.length === 0) return null;
      return h('section', { class: 'card', 'data-help': 'unlinked' }, [
        h('div', { class: 'card-head' }, h('h2', 'Sign-in attempts without a user')),
        h('div', { class: 'card-body' }, [
          h(
            'p',
            { class: 'muted' },
            'These accounts signed in at their provider and belong to no user here, or to one for another realm. An account is its provider and its id, and nothing else: the name is what the account calls itself, and anybody can pick any name there, also that of a user here. Link an account only when you know whose it is.',
          ),
          h(
            'ul',
            { class: 'rows' },
            attempts.map(({ provider, subject, realm, name }) => {
              const key = `${provider}:${subject}`;
              return h('li', { key, 'data-unlinked': key }, [
                h('strong', providerName(provider)),
                h('code', subject),
                realmOf(realm),
                name === undefined
                  ? null
                  : h(
                      'span',
                      { class: 'muted', 'data-claimed-name': '' },
                      `calls itself "${name}"`,
                    ),
                h(
                  'select',
                  {
                    value: chosenUser.value[key] ?? '',
                    'aria-label': `User to link the account ${subject} to`,
                    onChange: (event: Event) => {
                      chosenUser.value = {
                        ...chosenUser.value,
                        [key]: (event.target as HTMLSelectElement).value,
                      };
                    },
                  },
                  [
                    h('option', { value: '' }, 'Link to…'),
                    ...users.value
                      .filter((user) => !user.devMode)
                      .map((user) => h('option', { key: user.id, value: user.id }, user.name)),
                  ],
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'small',
                    'data-action': 'link',
                    disabled: !chosenUser.value[key],
                    onClick: () => {
                      const userId = chosenUser.value[key];
                      if (userId) void link(userId, provider, subject, realm);
                    },
                  },
                  'Link',
                ),
              ]);
            }),
          ),
        ]),
      ]);
    };

    const remove = (user: User, question: string) =>
      h(
        'button',
        {
          type: 'button',
          class: 'small danger',
          'data-action': 'delete',
          onClick: () => sure(question) && send('DELETE', `/api/v1/users/${part(user.id)}`),
        },
        'Delete',
      );
    /** The user of dev mode: shown as what it is, with nothing to change but deleting it. */
    const devModeRow = (user: User) =>
      h('li', { key: user.id, 'data-user': user.name }, [
        h('strong', user.name),
        h(
          'span',
          {
            class: 'state installed',
            'data-dev-mode': '',
            title:
              'Created by "mooncg dev", which acts as this user without a password. It cannot sign in, and outside dev mode it is nobody: its tokens are not accepted and it does not count as a user.',
          },
          'dev mode only',
        ),
        h('span', { class: 'checks' }, user.roles.join(', ')),
        remove(
          user,
          `Delete the user "${user.name}" of dev mode? Its tokens and preferences go too. Dev mode creates it again at its next start.`,
        ),
      ]);

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
                user.devMode
                  ? devModeRow(user)
                  : h('li', { key: user.id, 'data-user': user.name }, [
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
                      remove(
                        user,
                        `Delete the user "${user.name}"? Their sessions and tokens go too.`,
                      ),
                      h(
                        'form',
                        { class: 'inline', onSubmit: (event: Event) => reset(event, user) },
                        [
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
                        ],
                      ),
                      identities(user),
                    ]),
              ),
            ),
          ),
          h('div', { class: 'column' }, [
            unlinked(),
            selfLinkingCard(),
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
        ]),
      ]);
  },
});
