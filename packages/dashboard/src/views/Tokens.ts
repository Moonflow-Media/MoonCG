import { defineComponent, h, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { field, part, sure, useActions } from './admin.js';

interface Token {
  readonly id: string;
  readonly name: string;
  readonly grants: readonly string[];
  readonly expires: string | null;
  readonly lastUsed: string | null;
}

const when = (time: string | null) =>
  time === null ? 'never' : time.slice(0, 16).replace('T', ' ');

/** API tokens: create one (its secret is shown once), see when each was used, revoke. */
export const TokensView = defineComponent({
  name: 'TokensView',
  setup() {
    const tokens = ref<Token[]>([]);
    /** The secret of the token created just now. It is not kept anywhere else. */
    const secret = ref('');
    const { run, send, alert } = useActions(async () => {
      tokens.value = (await api.request<{ tokens: Token[] }>('GET', '/api/v1/tokens')).tokens;
    });
    onMounted(() => run(async () => {}));

    const create = async (event: Event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const day = field(event, 'expires');
      const body = {
        name: field(event, 'name').trim(),
        grants: field(event, 'grants')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
        ...(day === '' ? {} : { expires: new Date(`${day}T00:00:00Z`).toISOString() }),
      };
      secret.value = '';
      const done = await run(async () => {
        const created = await api.request<{ secret: string }>('POST', '/api/v1/tokens', body);
        secret.value = created.secret;
      });
      if (done) form.reset();
    };

    return () =>
      h('div', [
        h('h1', 'API tokens'),
        h(
          'p',
          { class: 'muted' },
          'A token can hold nothing you do not hold, and only while you hold it. For a graphic in OBS, grant the view permission of its bundle and nothing else.',
        ),
        alert(),
        secret.value
          ? h('p', { class: 'secret', 'data-secret': '' }, [
              'This is the only time the secret is shown: ',
              h('code', secret.value),
            ])
          : null,
        h(
          'ul',
          { class: 'rows' },
          tokens.value.map((token) =>
            h('li', { key: token.id, 'data-token': token.id }, [
              h('strong', token.name),
              h('code', ` ${token.grants.join(', ')} `),
              h(
                'span',
                { class: 'muted' },
                `expires ${when(token.expires)}, last used ${when(token.lastUsed)} `,
              ),
              h(
                'button',
                {
                  type: 'button',
                  'data-action': 'revoke',
                  onClick: () =>
                    sure(`Revoke the token "${token.name}"? What uses it stops working.`) &&
                    send('DELETE', `/api/v1/tokens/${part(token.id)}`),
                },
                'Revoke',
              ),
            ]),
          ),
        ),
        h('h2', 'New token'),
        h('form', { class: 'stack', 'data-form': 'create', onSubmit: create }, [
          h('label', ['Name ', h('input', { name: 'name', required: true, autocomplete: 'off' })]),
          h('label', [
            'Grants, one per line ',
            h('textarea', { name: 'grants', required: true, rows: 3 }),
          ]),
          h('label', ['Expires (optional) ', h('input', { name: 'expires', type: 'date' })]),
          h('button', { type: 'submit' }, 'Create token'),
        ]),
      ]);
  },
});
