import { defineComponent, h, onMounted, ref } from 'vue';
import { api, messageOf } from '../api.js';
import { useSession } from '../stores/session.js';
import { field, part, sure } from './admin.js';
import { pageHead } from './parts.js';

interface OwnIdentities {
  readonly identities: readonly {
    readonly provider: string;
    readonly subject: string;
    readonly realm?: string;
  }[];
  readonly providers: readonly {
    readonly id: string;
    readonly name: string;
    readonly selfLink: boolean;
  }[];
  /** Whether the user has a password. */
  readonly password: boolean;
}

/** Leaving the page for a provider, or for the login. Tests put their own in its place. */
export const accountNavigation = {
  go(url: string): void {
    location.assign(url);
  },
};

/** What a link that came back refused says, by the reason in the address. */
const REFUSED: Readonly<Record<string, string>> = {
  session:
    'The link was not finished: it must be finished in the browser and the session that started it.',
  elsewhere: 'That account is linked to another user. It is not moved: ask an administrator.',
  realm: 'That account is linked to you for another realm of the provider, and is left as it is.',
  provider: 'The provider refused, or could not be reached.',
  state: 'The link took too long or was started elsewhere. Start it again.',
  throttled: 'Too many attempts. Try again later.',
};

/** The page of the signed-in user: who they are, their password, and their linked accounts. */
export const AccountView = defineComponent({
  name: 'AccountView',
  setup() {
    const session = useSession();
    const own = ref<OwnIdentities>();
    const problem = ref('');
    const done = ref('');
    const passwordDone = ref(false);
    const passwordProblem = ref('');
    const linkPassword = ref('');

    const load = async () => {
      try {
        own.value = await api.request<OwnIdentities>('GET', '/api/v1/me/identities');
      } catch (error) {
        problem.value = messageOf(error);
      }
    };
    const nameOf = (provider: string) =>
      own.value?.providers.find((candidate) => candidate.id === provider)?.name ?? provider;
    onMounted(async () => {
      await load();
      const query = new URLSearchParams(location.search);
      const linked = query.get('linked');
      const error = query.get('error');
      // Only for a provider there is: the address is anyone's to write.
      if (linked && own.value?.providers.some((provider) => provider.id === linked)) {
        done.value = `Your account of ${nameOf(linked)} is linked. You can sign in with it.`;
      }
      if (error) problem.value = REFUSED[error] ?? 'The account was not linked.';
    });

    /** What linking and unlinking send: the password, for a user who has one. */
    const confirmation = () => (own.value?.password ? { password: linkPassword.value } : {});
    const link = async (provider: string) => {
      problem.value = '';
      done.value = '';
      try {
        const { url } = await api.request<{ url: string }>(
          'POST',
          `/api/v1/me/identities/${part(provider)}/link`,
          confirmation(),
        );
        linkPassword.value = '';
        accountNavigation.go(url);
      } catch (error) {
        problem.value = messageOf(error);
      }
    };
    const unlink = async (provider: string, subject: string) => {
      if (
        !sure(
          `Unlink your account of ${nameOf(provider)}? You can no longer sign in with it, and you are signed out everywhere.`,
        )
      ) {
        return;
      }
      problem.value = '';
      try {
        await api.request(
          'DELETE',
          `/api/v1/me/identities/${part(provider)}/${part(subject)}`,
          confirmation(),
        );
        linkPassword.value = '';
        accountNavigation.go('/login');
      } catch (error) {
        problem.value = messageOf(error);
      }
    };
    const changePassword = async (event: Event) => {
      event.preventDefault();
      passwordDone.value = false;
      passwordProblem.value = '';
      const form = event.currentTarget as HTMLFormElement;
      try {
        await api.request('POST', '/api/v1/me/password', {
          current: field(event, 'current'),
          password: field(event, 'password'),
        });
        form.reset();
        passwordDone.value = true;
      } catch (error) {
        passwordProblem.value = messageOf(error);
      }
    };

    const identities = () => {
      const data = own.value;
      if (!data) return null;
      const linkable = data.providers.filter((provider) => provider.selfLink);
      return h('section', { class: 'card' }, [
        h('div', { class: 'card-head' }, h('h2', 'Signing in with other accounts')),
        h('div', { class: 'card-body' }, [
          data.identities.length === 0
            ? h('p', { class: 'empty' }, 'No account of another provider is linked to you.')
            : h(
                'ul',
                { class: 'rows' },
                data.identities.map((identity) =>
                  h(
                    'li',
                    { key: `${identity.provider}/${identity.subject}`, 'data-identity': '' },
                    [
                      h('span', `${nameOf(identity.provider)}: ${identity.subject}`),
                      h(
                        'button',
                        {
                          type: 'button',
                          class: 'small danger',
                          onClick: () => unlink(identity.provider, identity.subject),
                        },
                        'Unlink',
                      ),
                    ],
                  ),
                ),
              ),
          linkable.length === 0 && data.identities.length === 0
            ? null
            : data.password
              ? h('label', [
                  'Your password, to link or unlink an account',
                  h('input', {
                    type: 'password',
                    name: 'link-password',
                    autocomplete: 'current-password',
                    value: linkPassword.value,
                    onInput: (event: Event) => {
                      linkPassword.value = (event.target as HTMLInputElement).value;
                    },
                  }),
                ])
              : h(
                  'p',
                  { class: 'field-note' },
                  'You have no password: sign out and sign in again, then link or unlink an account within five minutes.',
                ),
          linkable.length === 0
            ? null
            : h('div', { class: 'stack' }, [
                h(
                  'div',
                  { class: 'form-actions' },
                  linkable.map((provider) =>
                    h(
                      'button',
                      { type: 'button', key: provider.id, onClick: () => link(provider.id) },
                      `Link ${provider.name}`,
                    ),
                  ),
                ),
                h(
                  'p',
                  { class: 'field-note' },
                  'You are sent to the provider and come back here. Whoever has the account you link can sign in as you.',
                ),
              ]),
        ]),
      ]);
    };

    const password = () =>
      own.value?.password
        ? h('section', { class: 'card' }, [
            h('div', { class: 'card-head' }, h('h2', 'Password')),
            h('form', { class: 'card-body stack', 'data-password': '', onSubmit: changePassword }, [
              h('label', [
                'Current password',
                h('input', {
                  type: 'password',
                  name: 'current',
                  required: true,
                  autocomplete: 'current-password',
                }),
              ]),
              h('label', [
                'New password',
                h('input', {
                  type: 'password',
                  name: 'password',
                  required: true,
                  minlength: 8,
                  autocomplete: 'new-password',
                }),
              ]),
              h('div', h('button', { type: 'submit', class: 'primary' }, 'Change password')),
              passwordDone.value
                ? h('p', { class: 'done', role: 'status' }, 'The password is changed.')
                : null,
              passwordProblem.value
                ? h('p', { class: 'problem', role: 'alert' }, passwordProblem.value)
                : null,
            ]),
          ])
        : null;

    return () =>
      h('div', [
        pageHead('Account', { description: 'Who you are signed in as, and how you sign in.' }),
        problem.value ? h('p', { class: 'problem', role: 'alert' }, problem.value) : null,
        done.value ? h('p', { class: 'done', role: 'status' }, done.value) : null,
        h('section', { class: 'card' }, [
          h('div', { class: 'card-head' }, h('h2', 'You')),
          h('dl', { class: 'card-body facts' }, [
            h('div', [h('dt', 'Name'), h('dd', { 'data-account-name': '' }, session.name)]),
            h('div', [
              h('dt', 'Roles'),
              h('dd', { 'data-account-roles': '' }, session.roles.join(', ') || 'none'),
            ]),
          ]),
        ]),
        password(),
        identities(),
      ]);
  },
});
