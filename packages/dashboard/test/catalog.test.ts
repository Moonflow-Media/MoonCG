// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.js';
import { live } from '../src/live.js';
import { routes } from '../src/router.js';
import { describeSource } from '../src/stores/installs.js';
import { useSession } from '../src/stores/session.js';
import { BundlesView } from '../src/views/Bundles.js';
import { CatalogView, catalogTiming } from '../src/views/Catalog.js';
import { ModulesView } from '../src/views/Modules.js';

type Call = { method: string; path: string; body: unknown };
const INDEX = { id: 'aaaaaaaaaaaaaaaa', url: 'https://one.example.org/index.json', title: 'One' };
const ENTRY = {
  index: INDEX,
  kind: 'bundle',
  name: 'ticker',
  title: 'Ticker',
  description: 'Lines along the bottom.',
  author: 'Studio',
  homepage: 'https://example.org/ticker',
  license: 'MIT',
  tags: ['news'],
  versions: [
    {
      version: '2.0.0',
      engine: '>=9.0.0',
      dependencies: {},
      compatible: false,
      problem: 'engine.mooncg: needs MoonCG >=9.0.0, but this is 0.10.0',
      source: {
        type: 'zip',
        location: 'https://one.example.org/ticker-2.0.0.zip',
        sha256: 'a'.repeat(64),
      },
    },
    {
      version: '1.1.0',
      dependencies: {},
      compatible: true,
      source: {
        type: 'zip',
        location: 'https://one.example.org/ticker-1.1.0.zip',
        sha256: 'a'.repeat(64),
      },
    },
  ],
  installed: { version: '1.0.0', fromThisEntry: true },
  update: { version: '1.1.0' },
};
const MODULE_ENTRY = {
  ...ENTRY,
  kind: 'module',
  name: 'greeter',
  title: 'Greeter',
  installed: undefined,
  update: undefined,
};
const INDEXES = {
  canEdit: true,
  refreshMs: 21_600_000,
  indexes: [
    { ...INDEX, origin: 'config', status: 'ok', entries: 2, fetchedAt: '2026-11-25T10:00:00.000Z' },
    {
      id: 'bbbbbbbbbbbbbbbb',
      url: 'https://two.example.org/index.json',
      origin: 'added',
      status: 'stale',
      error: 'https://two.example.org/index.json answered 503',
      entries: 4,
    },
  ],
};

function serve(table: Record<string, unknown>) {
  const calls: Call[] = [];
  api.request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const answer = table[`${method} ${path}`] ?? table[`${method} ${path.split('?')[0]}`];
    if (answer instanceof Error) throw answer;
    return structuredClone(answer);
  }) as typeof api.request;
  return calls;
}
const sent = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

function signIn(permissions: string[]) {
  useSession().me = { user: { id: 'u1', kind: 'user', name: 'ada' }, roles: [], permissions };
}

/** What the pages follow live, by replicant name, and a way to push a new value to them. */
let followed: Map<string, (value: unknown) => void>;
const push = (name: string, value: unknown) => followed.get(name)?.(value);

beforeEach(() => {
  setActivePinia(createPinia());
  catalogTiming.pollMs = 0;
  followed = new Map();
  live.follow = ((name: string, listener: (value: unknown) => void) => {
    followed.set(name, listener);
    return () => followed.delete(name);
  }) as typeof live.follow;
});
afterEach(() => {
  document.body.replaceChildren();
});

async function show(permissions = ['*'], table: Record<string, unknown> = {}) {
  signIn(permissions);
  const calls = serve({
    'GET /api/v1/registry/indexes': INDEXES,
    'GET /api/v1/registry/catalog': {
      mooncg: '0.10.0',
      entries: [ENTRY, MODULE_ENTRY],
      indexes: INDEXES.indexes,
    },
    ...table,
  });
  const view = mount(CatalogView, { attachTo: document.body });
  await flushPromises();
  return { view, calls };
}

describe('the catalog page', () => {
  it('is a route of the dashboard', () => {
    expect(routes.map((route) => route.path)).toContain('/bundles/catalog');
  });

  it('shows each entry with its versions, compatibility and what is installed', async () => {
    const { view } = await show();
    const card = view.find('[data-entry="bundle:ticker"]');
    expect(card.text()).toContain('Ticker');
    expect(card.text()).toContain('Lines along the bottom.');
    expect(card.text()).toContain('Installed: 1.0.0');
    expect(card.find('[data-badge="update"]').text()).toBe('Update available: 1.1.0');
    expect(card.text()).toMatch(/2\.0\.0.*needs MoonCG >=9\.0\.0/);
    expect(card.text()).toContain('one.example.org/index.json');
    // No picture of anyone else's server is ever loaded.
    expect(view.findAll('img')).toHaveLength(0);
  });

  it('tells how each index stands, and lets whoever may change them do so', async () => {
    const { view, calls } = await show();
    const stale = view.find('[data-index="bbbbbbbbbbbbbbbb"]');
    expect(stale.text()).toMatch(/503/);
    expect(stale.text()).toMatch(/last good copy/i);
    // An index of the configuration is changed there.
    expect(view.find('[data-index="aaaaaaaaaaaaaaaa"] button').exists()).toBe(false);
    await stale.find('button').trigger('click');
    await flushPromises();
    await view.find('input[name="index-url"]').setValue('https://three.example.org/index.json');
    await view.find('form[data-form="add-index"]').trigger('submit');
    await flushPromises();
    const refresh = view.findAll('button').find((button) => button.text() === 'Check now');
    await refresh?.trigger('click');
    await flushPromises();
    expect(sent(calls)).toEqual([
      { method: 'DELETE', path: '/api/v1/registry/indexes/bbbbbbbbbbbbbbbb', body: undefined },
      {
        method: 'POST',
        path: '/api/v1/registry/indexes',
        body: { url: 'https://three.example.org/index.json' },
      },
      { method: 'POST', path: '/api/v1/registry/refresh', body: {} },
    ]);
  });

  it('names the module that provides an index, which is changed with the module alone', async () => {
    const { view } = await show(['*'], {
      'GET /api/v1/registry/indexes': {
        ...INDEXES,
        indexes: [
          {
            id: 'cccccccccccccccc',
            url: 'module://catalogue/studio',
            origin: 'module',
            module: 'catalogue',
            status: 'ok',
            entries: 1,
          },
        ],
      },
    });
    const row = view.find('[data-index="cccccccccccccccc"]');
    expect(row.find('.badge').text()).toBe('module catalogue');
    expect(row.find('button').exists()).toBe(false);
    view.unmount();
  });

  it('says when the indexes were checked moments ago and may not be checked yet', async () => {
    const { view } = await show(['*'], {
      'POST /api/v1/registry/refresh': new Error(
        'The indexes were checked moments ago. Try again in 20 s.',
      ),
    });
    const refresh = view.findAll('button').find((button) => button.text() === 'Check now');
    await refresh?.trigger('click');
    await flushPromises();
    expect(view.find('[role="alert"]').text()).toMatch(/Try again in 20 s/);
  });

  it('shows no way to change the indexes to whoever may not', async () => {
    const { view } = await show(['system:bundles.manage'], {
      'GET /api/v1/registry/indexes': { ...INDEXES, canEdit: false },
    });
    expect(view.find('form[data-form="add-index"]').exists()).toBe(false);
    expect(view.find('[data-index] button').exists()).toBe(false);
  });

  it('searches and narrows to one kind, and offers only the kinds one may manage', async () => {
    const { view, calls } = await show();
    await view.find('input[name="search"]').setValue('news');
    await view.find('form[data-form="search"]').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)?.path).toBe('/api/v1/registry/catalog?q=news');
    await view.find('[role="radio"][data-choice="module"]').trigger('click');
    await flushPromises();
    expect(calls.at(-1)?.path).toBe('/api/v1/registry/catalog?kind=module&q=news');

    const only = await show(['system:bundles.manage']);
    expect(only.view.find('[role="radio"][data-choice="module"]').exists()).toBe(false);
    expect(only.calls.find((call) => call.path.includes('catalog'))?.path).toBe(
      '/api/v1/registry/catalog?kind=bundle',
    );
  });

  it('installs and updates through staging, and says where to decide', async () => {
    const { view, calls } = await show(['*'], {
      'POST /api/v1/registry/stage': { job: { id: 'j1', operation: 'stage', state: 'running' } },
      'GET /api/v1/bundles/-/jobs/j1': {
        job: { id: 'j1', operation: 'stage', state: 'succeeded', staged: { id: 's1' } },
      },
    });
    const card = view.find('[data-entry="bundle:ticker"]');
    await card
      .findAll('button')
      .find((button) => button.text() === 'Update to 1.1.0')
      ?.trigger('click');
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await flushPromises();
    expect(sent(calls)).toEqual([
      {
        method: 'POST',
        path: '/api/v1/registry/stage',
        body: { kind: 'bundle', index: INDEX.id, name: 'ticker', update: true },
      },
    ]);
    expect(view.text()).toMatch(/fetched and waits on the Bundles page/);
    const module = view.find('[data-entry="module:greeter"]');
    expect(module.findAll('button').map((button) => button.text())).toContain('Install');
  });
});

describe('update hints on the Bundles page', () => {
  it('shows a badge and starts the update from the index', async () => {
    signIn(['*']);
    live.follow = (() => () => {}) as typeof live.follow;
    const calls = serve({
      'GET /api/v1/bundles': {
        canManage: true,
        backupsKept: 3,
        bundles: [
          {
            name: 'ticker',
            state: 'running',
            version: '1.0.0',
            errors: [],
            panels: [],
            graphics: [],
          },
        ],
      },
      'GET /api/v1/registry/updates': {
        updates: [
          { kind: 'bundle', name: 'ticker', installed: '1.0.0', available: '1.1.0', index: INDEX },
        ],
      },
      'GET /api/v1/bundles/-/backups': { bundles: [] },
      'POST /api/v1/registry/stage': { job: { id: 'j2', operation: 'stage', state: 'running' } },
    });
    const view = mount(BundlesView, { attachTo: document.body });
    await flushPromises();
    const row = view.find('[data-bundle="ticker"]');
    expect(row.find('[data-badge="update"]').text()).toBe('Update available: 1.1.0');
    await row
      .findAll('button')
      .find((button) => button.text() === 'Update to 1.1.0')
      ?.trigger('click');
    await flushPromises();
    expect(sent(calls)).toEqual([
      {
        method: 'POST',
        path: '/api/v1/registry/stage',
        body: { kind: 'bundle', index: INDEX.id, name: 'ticker', update: true },
      },
    ]);
    view.unmount();
  });
});

describe('update hints, live', () => {
  const HINT = {
    kind: 'bundle',
    name: 'ticker',
    installed: '1.0.0',
    available: '1.1.0',
    index: INDEX,
  };
  const BUNDLES = {
    canManage: true,
    backupsKept: 3,
    bundles: [
      { name: 'ticker', state: 'running', version: '1.0.0', errors: [], panels: [], graphics: [] },
    ],
  };

  it('show on the Bundles page as soon as the server says so, without a reload', async () => {
    signIn(['*']);
    serve({
      'GET /api/v1/bundles': BUNDLES,
      'GET /api/v1/registry/updates': { updates: [] },
      'GET /api/v1/bundles/-/backups': { bundles: [] },
    });
    const view = mount(BundlesView, { attachTo: document.body });
    await flushPromises();
    expect(view.find('[data-badge="update"]').exists()).toBe(false);
    push('system:updates.bundles', { updates: [HINT], revision: 2 });
    await flushPromises();
    expect(view.find('[data-badge="update"]').text()).toBe('Update available: 1.1.0');
    push('system:updates.bundles', { updates: [], revision: 3 });
    await flushPromises();
    expect(view.find('[data-badge="update"]').exists()).toBe(false);
    view.unmount();
    expect(followed.has('system:updates.bundles')).toBe(false);
  });

  it('show on the Modules page for modules, and leave the hints of bundles alone', async () => {
    signIn(['system:modules.manage']);
    serve({
      'GET /api/v1/modules': {
        modules: [
          {
            name: 'greeter',
            version: '1.0.0',
            enabled: false,
            state: 'disabled',
            builtin: false,
            internal: false,
            config: false,
            providers: [],
            permissions: [],
            routes: 0,
          },
        ],
      },
      'GET /api/v1/registry/updates': { updates: [] },
    });
    const view = mount(ModulesView);
    await flushPromises();
    // Only the kind the user manages is followed.
    expect([...followed.keys()]).toEqual(['system:updates.modules']);
    push('system:updates.modules', {
      updates: [{ ...HINT, kind: 'module', name: 'greeter' }],
      revision: 1,
    });
    await flushPromises();
    expect(view.find('[data-module="greeter"] [data-badge="update"]').text()).toBe(
      'Update available: 1.1.0',
    );
    view.unmount();
  });

  it('bring the catalog up to date when the indexes or what is installed changed', async () => {
    const { calls, view } = await show();
    const catalogReads = () =>
      calls.filter((call) => call.path.startsWith('/api/v1/registry/catalog'));
    expect(catalogReads()).toHaveLength(1);
    // The first value is what was there when the page was opened.
    push('system:updates.bundles', { updates: [], revision: 4 });
    await flushPromises();
    expect(catalogReads()).toHaveLength(1);
    push('system:updates.bundles', { updates: [HINT], revision: 5 });
    await flushPromises();
    expect(catalogReads()).toHaveLength(2);
    // The same news for the other kind is taken once.
    push('system:updates.modules', { updates: [], revision: 7 });
    push('system:updates.modules', { updates: [], revision: 8 });
    await flushPromises();
    expect(catalogReads().length).toBeGreaterThanOrEqual(3);
    view.unmount();
  });
});

describe('describeSource', () => {
  it('says an archive from an address with its checksum and the index it was listed in', () => {
    expect(
      describeSource({
        type: 'url',
        location: 'https://one.example.org/ticker.zip',
        sha256: 'abcdef0123456789'.repeat(4),
        catalog: {
          index: INDEX.id,
          indexUrl: INDEX.url,
          kind: 'bundle',
          name: 'ticker',
          version: '1.0.0',
        },
      }),
    ).toBe(
      'archive https://one.example.org/ticker.zip (SHA-256 abcdef012345…), listed as ticker 1.0.0 in https://one.example.org/index.json',
    );
  });
});
