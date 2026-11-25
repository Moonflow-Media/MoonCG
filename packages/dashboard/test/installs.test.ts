// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api.js';
import { live } from '../src/live.js';
import { describeSource, useInstalls } from '../src/stores/installs.js';
import { useOnAir } from '../src/stores/onAir.js';
import { BundlesView } from '../src/views/Bundles.js';

type Listener = (value: unknown) => void;

const GIT = {
  type: 'git',
  location: 'https://example.org/o/board.git',
  ref: 'main',
  commit: 'abcdef1234567890',
};
const kept = { backups: 3 };
/** Bundles listed after the three every test has. */
const more: object[] = [];
const bundles = (canManage: boolean) => ({
  canManage,
  ...(canManage ? { backupsKept: kept.backups } : {}),
  bundles: [
    {
      name: 'board',
      title: 'Board',
      state: 'running',
      version: '1.0.0',
      errors: [],
      panels: [],
      graphics: [],
      ...(canManage ? { source: GIT } : {}),
    },
    { name: 'ticker', state: 'running', version: '0.2.0', errors: [], panels: [], graphics: [] },
    { name: 'off', state: 'disabled', version: '3.0.0', errors: [], panels: [], graphics: [] },
    ...more,
  ],
});
const STAGED = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'clock',
  version: '2.1.0',
  title: 'Clock',
  source: { type: 'upload', location: 'clock.zip' },
  engine: '>=0.6.0',
  permissions: [
    { name: 'view', description: 'See the clock' },
    { name: 'operate', description: '' },
  ],
  capabilities: ['http.routes'],
  dependencies: { board: '^1.0.0' },
  extension: true,
  panels: 2,
  dialogs: 0,
  graphics: 1,
  assets: 0,
  config: true,
  npm: { needed: true, lockfile: true, dependencies: ['luxon'], installed: false },
  files: 12,
  bytes: 4096,
};
const job = (id: string, extra: object = {}) => ({
  id,
  operation: 'stage',
  state: 'running',
  by: 'ada',
  startedAt: '2026-11-24T10:00:00.000Z',
  ...extra,
});

const realUpload = api.upload;
const realConfirm = globalThis.confirm;

function setup(canManage = true) {
  const followed = new Map<string, Listener>();
  const stopped: string[] = [];
  live.follow = ((name: string, listener: Listener) => {
    followed.set(name, listener);
    return () => stopped.push(name);
  }) as typeof live.follow;
  const calls: { method: string; path: string; body: unknown }[] = [];
  /** What the next requests are answered with, by `METHOD path`. */
  const answers = new Map<string, unknown>();
  let next = 1;
  api.request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (path === '/api/v1/bundles') return structuredClone(bundles(canManage));
    const answer = answers.get(`${method} ${path}`);
    if (answer instanceof Error) throw answer;
    if (answer === undefined && method === 'GET') return { bundles: [] };
    return answer ?? { job: job(`job-${next++}`) };
  }) as typeof api.request;
  const uploads: { path: string; name: string }[] = [];
  api.upload = vi.fn(async (path: string, file: Blob) => {
    uploads.push({ path, name: (file as File).name });
    return { job: job(`job-${next++}`) };
  }) as typeof api.upload;
  const asked: string[] = [];
  const confirms = { answer: true };
  globalThis.confirm = (question?: string) => {
    asked.push(question ?? '');
    return confirms.answer;
  };
  /** What the server publishes about installations. */
  const publish = (value: { jobs?: unknown[]; staged?: unknown[] }) =>
    followed.get('system:installs')?.({ jobs: [], staged: [], ...value });
  return { followed, stopped, calls, answers, uploads, asked, confirms, publish };
}

async function show() {
  const view = mount(BundlesView, { attachTo: document.body });
  await flushPromises();
  return view;
}
const row = (view: VueWrapper, name: string) => view.find(`[data-bundle="${name}"]`);
const button = (wrapper: { findAll: VueWrapper['findAll'] }, label: string) =>
  wrapper.findAll('button').find((candidate) => candidate.text() === label);
const choose = (view: VueWrapper, choice: string) =>
  view.find(`.install [role="radio"][data-choice="${choice}"]`).trigger('click');

beforeEach(() => {
  setActivePinia(createPinia());
  kept.backups = 3;
  more.length = 0;
});
afterEach(() => {
  api.upload = realUpload;
  globalThis.confirm = realConfirm;
  document.body.replaceChildren();
});

describe('describeSource', () => {
  it('says where a bundle came from in a few words', () => {
    expect(describeSource(GIT as never)).toBe('https://example.org/o/board.git at main (abcdef1)');
    expect(describeSource({ type: 'git', location: 'git@example.org:o/r.git' })).toBe(
      'git@example.org:o/r.git',
    );
    expect(describeSource({ type: 'path', location: '/srv/board' })).toBe('folder /srv/board');
    expect(describeSource({ type: 'zip', location: '/srv/board.zip' })).toBe(
      'archive /srv/board.zip',
    );
    expect(describeSource({ type: 'upload', location: 'board.zip' })).toBe('upload board.zip');
  });
});

describe('without the permission to manage bundles', () => {
  it('shows no way to install, update or remove, and follows no installations', async () => {
    const { followed } = setup(false);
    const view = await show();
    expect(view.find('.install').exists()).toBe(false);
    expect(view.findAll('button').map((item) => item.text())).not.toEqual(
      expect.arrayContaining(['Update']),
    );
    expect(view.text()).not.toMatch(/Install bundle|Remove|Update/);
    expect(followed.has('system:installs')).toBe(false);
    view.unmount();
  });
});

describe('installing a bundle', () => {
  it('offers a Git address or a ZIP upload, and no path on the server', async () => {
    setup();
    const view = await show();
    const card = view.find('.install');
    expect(card.find('h2').text()).toBe('Install bundle');
    expect(card.findAll('[role="radio"]').map((item) => item.text())).toEqual([
      'Git address',
      'ZIP upload',
    ]);
    expect(card.find('input[name="url"]').exists()).toBe(true);
    expect(card.find('input[type="file"]').exists()).toBe(false);
    await choose(view, 'zip');
    expect(card.find('input[name="url"]').exists()).toBe(false);
    expect(card.find('input[type="file"]').attributes('accept')).toBe('.zip,application/zip');
    expect(card.text()).not.toMatch(/path/i);
    view.unmount();
  });

  it('fetches from a Git address, with the ref if one is given', async () => {
    const { calls } = setup();
    const view = await show();
    await view.find('.install input[name="url"]').setValue(' https://example.org/o/clock.git ');
    await view.find('.install input[name="ref"]').setValue('v2.1.0');
    await view.find('.install form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: '/api/v1/bundles/-/stage',
      body: { source: { type: 'git', url: 'https://example.org/o/clock.git', ref: 'v2.1.0' } },
    });

    await view.find('.install input[name="url"]').setValue('git@example.org:o/clock.git');
    await view.find('.install input[name="ref"]').setValue('  ');
    await view.find('.install form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)?.body).toEqual({
      source: { type: 'git', url: 'git@example.org:o/clock.git' },
    });
    view.unmount();
  });

  it('uploads a ZIP file under its name', async () => {
    const { uploads } = setup();
    const view = await show();
    await choose(view, 'zip');
    const input = view.find('.install input[type="file"]');
    const file = new File(['zip'], 'my clock.zip', { type: 'application/zip' });
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(uploads).toEqual([
      { path: '/api/v1/bundles/-/stage?filename=my%20clock.zip', name: 'my clock.zip' },
    ]);
    view.unmount();
  });

  it('shows why the server refused to fetch', async () => {
    const { answers } = setup();
    answers.set(
      'POST /api/v1/bundles/-/stage',
      new ApiError(
        400,
        'invalid',
        'Only https://, ssh:// and user@host:path Git addresses are accepted',
      ),
    );
    const view = await show();
    await view.find('.install input[name="url"]').setValue('file:///srv/x.git');
    await view.find('.install form').trigger('submit');
    await flushPromises();
    expect(view.find('.install .problem').text()).toContain('Only https://');
    expect(view.find('.install .problem').attributes('role')).toBe('alert');
    view.unmount();
  });

  it('shows the progress of what it started, and how it ended', async () => {
    const { publish } = setup();
    const view = await show();
    await view.find('.install input[name="url"]').setValue('https://example.org/o/clock.git');
    await view.find('.install form').trigger('submit');
    await flushPromises();

    publish({ jobs: [job('job-1', { step: 'fetch' })] });
    await flushPromises();
    const status = view.find('.install [role="status"]');
    expect(status.text()).toBe('Fetching the bundle (fetch)');
    // Nothing else can be started from the form meanwhile.
    expect(button(view.find('.install'), 'Fetch')?.attributes('disabled')).toBeDefined();

    publish({
      jobs: [job('job-1', { state: 'failed', step: 'validate', error: 'mooncg.json not found' })],
    });
    await flushPromises();
    expect(view.find('.install [role="status"]').exists()).toBe(false);
    expect(view.find('.install .problem').text()).toBe(
      'Fetching the bundle failed: mooncg.json not found',
    );
    expect(button(view.find('.install'), 'Fetch')?.attributes('disabled')).toBeUndefined();
    view.unmount();
  });

  it('shows the jobs of others while they run, and none of their past', async () => {
    const { publish } = setup();
    const view = await show();
    publish({
      jobs: [
        job('theirs', { operation: 'update', bundle: 'ticker', step: 'place' }),
        job('old', { state: 'failed', error: 'long ago' }),
      ],
    });
    await flushPromises();
    expect(view.findAll('.install [role="status"]').map((item) => item.text())).toEqual([
      'Updating ticker (place)',
    ]);
    expect(view.find('.install').text()).not.toContain('long ago');
    view.unmount();
  });
});

describe('a staged bundle', () => {
  async function staged(extra: object = {}) {
    const context = setup();
    const view = await show();
    context.publish({ staged: [{ ...STAGED, ...extra }] });
    await flushPromises();
    return { ...context, view, card: view.find(`[data-staged="${STAGED.id}"]`) };
  }

  it('shows what the bundle declares before anything is installed', async () => {
    const { view, card } = await staged();
    expect(card.find('h2').text()).toBe('Clock clock 2.1.0');
    expect(card.find('.badge').text()).toBe('New');
    const facts = Object.fromEntries(
      card.findAll('.facts > div').map((fact) => [fact.find('dt').text(), fact.find('dd').text()]),
    );
    expect(facts).toEqual({
      Source: 'upload clock.zip',
      'Server code': 'Yes: it brings an extension that runs on the server',
      'Runs code on install':
        'No, unless the install scripts of its npm packages are allowed below',
      Permissions: 'view (See the clock), operate',
      'Role grants': 'none',
      Capabilities: 'http.routes',
      'Needs bundles': 'board ^1.0.0',
      'Needs MoonCG': '>=0.6.0',
      'npm packages': 'luxon, installed before the bundle starts',
      Provides: '2 panels, 0 dialogs, 1 graphic, 0 asset categories, settings',
      Size: '12 files, 4.0 KiB',
    });
    expect(button(card, 'Install')).toBeDefined();
    expect(button(card, 'Discard')).toBeDefined();
    view.unmount();
  });

  it('says so when a bundle brings no server code and needs nothing', async () => {
    const { view, card } = await staged({
      extension: false,
      permissions: [],
      capabilities: [],
      dependencies: {},
      engine: undefined,
      npm: { needed: false, lockfile: false, dependencies: [], installed: false },
    });
    const text = card.find('.facts').text();
    expect(text).toContain('No');
    expect(text).not.toContain('Needs MoonCG');
    expect(card.findAll('.facts dd').map((item) => item.text())).toEqual(
      expect.arrayContaining(['none']),
    );
    expect(card.find('input[type="checkbox"]').exists()).toBe(false);
    view.unmount();
  });

  it('installs it, without the install scripts of npm packages unless that is ticked', async () => {
    const { view, card, calls } = await staged();
    await button(card, 'Install')?.trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: `/api/v1/bundles/-/staged/${STAGED.id}/commit`,
      body: { scripts: false },
    });

    const scripts = card.find('input[type="checkbox"]');
    expect(scripts.element.closest('label')?.textContent).toMatch(/install scripts/);
    await scripts.setValue(true);
    await button(card, 'Install')?.trigger('click');
    await flushPromises();
    expect(calls.at(-1)?.body).toEqual({ scripts: true });
    view.unmount();
  });

  it('discards it', async () => {
    const { view, card, calls } = await staged();
    await button(card, 'Discard')?.trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/api/v1/bundles/-/staged/${STAGED.id}`,
    });
    view.unmount();
  });

  describe('while the installation is on air', () => {
    const UPDATE = { name: 'board', title: 'Board', target: 'board', replaces: '1.0.0' };

    it('fetches an update without a question: fetching interrupts nothing', async () => {
      const { calls, asked } = setup();
      useOnAir().onAir = true;
      const view = await show();
      await button(row(view, 'board'), 'Update')?.trigger('click');
      await view
        .find('.install')
        .findAll('button')
        .find((item) => item.text().startsWith('Fetch from'))
        ?.trigger('click');
      await flushPromises();

      expect(asked).toEqual([]);
      expect(calls.at(-1)).toEqual({
        method: 'POST',
        path: '/api/v1/bundles/board/update',
        body: {},
      });
      view.unmount();
    });

    it('says on a fetched update that putting it in place is blocked, and what to do', async () => {
      useOnAir().onAir = true;
      const { view, card } = await staged(UPDATE);
      const note = card.find('[data-on-air-note]');
      expect(note.text()).toContain('on air');
      expect(note.text()).toContain('"board"');
      expect(note.text()).toMatch(/stays here|wait/);
      view.unmount();
    });

    it('says nothing of the kind on a new bundle, or off air', async () => {
      useOnAir().onAir = true;
      const fresh = await staged();
      expect(fresh.card.find('[data-on-air-note]').exists()).toBe(false);
      fresh.view.unmount();
      useOnAir().onAir = false;
      const update = await staged(UPDATE);
      expect(update.card.find('[data-on-air-note]').exists()).toBe(false);
      update.view.unmount();
    });

    it('asks before an update is put in place, and overrides the lock only on a yes', async () => {
      useOnAir().onAir = true;
      const { view, card, calls, asked, confirms } = await staged(UPDATE);
      const posts = () => calls.filter((call) => call.method === 'POST');

      confirms.answer = false;
      await button(card, 'Update')?.trigger('click');
      await flushPromises();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('on air');
      expect(asked[0]).toContain('Update "board"');
      expect(posts()).toEqual([]);

      confirms.answer = true;
      await button(card, 'Update')?.trigger('click');
      await flushPromises();
      expect(posts()).toEqual([
        {
          method: 'POST',
          path: `/api/v1/bundles/-/staged/${STAGED.id}/commit`,
          body: { scripts: false, forceOnAir: true },
        },
      ]);
      view.unmount();
    });

    it('installs a new bundle without a question and without overriding anything', async () => {
      useOnAir().onAir = true;
      const { view, card, calls, asked } = await staged();
      await button(card, 'Install')?.trigger('click');
      await flushPromises();
      expect(asked).toEqual([]);
      expect(calls.at(-1)?.body).toEqual({ scripts: false });
      view.unmount();
    });
  });

  it('names an update as one, with both versions', async () => {
    const { view, card } = await staged({
      name: 'board',
      title: 'Board',
      target: 'board',
      replaces: '1.0.0',
    });
    expect(card.find('.badge').text()).toBe('Update of 1.0.0');
    expect(button(card, 'Update')).toBeDefined();
    expect(button(card, 'Install')).toBeUndefined();
    view.unmount();
  });

  it('says how an installation it started ended', async () => {
    const { view, card, publish, answers } = await staged();
    answers.set(`POST /api/v1/bundles/-/staged/${STAGED.id}/commit`, {
      job: job('commit-1', { operation: 'update', bundle: 'clock' }),
    });
    await button(card, 'Install')?.trigger('click');
    await flushPromises();
    publish({
      jobs: [
        job('commit-1', {
          operation: 'update',
          bundle: 'clock',
          state: 'rolled-back',
          error: 'Extension failed to start: boom',
        }),
      ],
    });
    await flushPromises();
    expect(view.find('.install .problem').text()).toBe(
      'Updating clock failed and was rolled back; the earlier version is in place again: Extension failed to start: boom',
    );

    publish({
      jobs: [job('commit-1', { operation: 'install', bundle: 'clock', state: 'succeeded' })],
    });
    await flushPromises();
    expect(view.find('.install .problem').exists()).toBe(false);
    expect(view.find('.install .done').text()).toBe('Installing clock is done.');
    view.unmount();
  });
});

describe('a bundle in the list', () => {
  it('shows its version and where it came from', async () => {
    setup();
    const view = await show();
    expect(row(view, 'board').find('small').text()).toBe('board 1.0.0');
    expect(row(view, 'board').find('.bundle-facts').text()).toContain(
      'from https://example.org/o/board.git at main (abcdef1)',
    );
    expect(row(view, 'ticker').find('.bundle-facts').text()).not.toContain('from');
    view.unmount();
  });

  it('removes it after a confirmation that says what is kept and what is lost', async () => {
    const { calls } = setup();
    const view = await show();
    await button(row(view, 'ticker'), 'Remove')?.trigger('click');
    const panel = row(view, 'ticker').find('[data-remove]');
    expect(panel.text()).toMatch(/files are moved to the backups/);
    expect(panel.text()).toMatch(
      /settings, uploaded assets, stored values and the role grants for it are kept/,
    );
    expect(calls.filter(({ method }) => method !== 'GET')).toEqual([]);

    await button(panel, 'Cancel')?.trigger('click');
    expect(row(view, 'ticker').find('[data-remove]').exists()).toBe(false);
    expect(calls.filter(({ method }) => method !== 'GET')).toEqual([]);

    await button(row(view, 'ticker'), 'Remove')?.trigger('click');
    await button(row(view, 'ticker').find('[data-remove]'), 'Remove ticker')?.trigger('click');
    await flushPromises();
    expect(calls.filter(({ method }) => method === 'POST').at(-1)).toEqual({
      method: 'POST',
      path: '/api/v1/bundles/ticker/remove',
      body: {},
    });
    view.unmount();
  });

  it('deletes the files and purges the data only when that is chosen, and says what is lost', async () => {
    const { calls } = setup();
    const view = await show();
    await button(row(view, 'ticker'), 'Remove')?.trigger('click');
    const panel = () => row(view, 'ticker').find('[data-remove]');
    await panel().find('input[name="deleteFiles"]').setValue(true);
    await panel().find('input[name="purgeData"]').setValue(true);
    expect(panel().text()).toMatch(/files are deleted/);
    expect(panel().text()).toMatch(/no backup of this version is kept, and there is no older one/i);
    expect(panel().text()).toMatch(
      /settings, uploaded assets, stored values and the role grants for it are deleted/,
    );
    await button(panel(), 'Remove ticker')?.trigger('click');
    await flushPromises();
    expect(calls.filter(({ method }) => method === 'POST').at(-1)).toEqual({
      method: 'POST',
      path: '/api/v1/bundles/ticker/remove',
      body: { deleteFiles: true, purgeData: true },
    });
    view.unmount();
  });

  it('says that purging the data takes the role grants for the bundle as well', async () => {
    setup();
    const view = await show();
    await button(row(view, 'ticker'), 'Remove')?.trigger('click');
    const purge = row(view, 'ticker').find('input[name="purgeData"]');
    expect(purge.element.parentElement?.textContent).toMatch(/role grants for it/);
    view.unmount();
  });

  it('says how many older backups remain when the files of this version are deleted', async () => {
    const { answers } = setup();
    const older = (version: string) => ({
      id: `${version}-20261120T100000000Z`,
      version,
      time: '2026-11-20T10:00:00.000Z',
      reason: 'update',
    });
    answers.set('GET /api/v1/bundles/-/backups', {
      bundles: [{ name: 'ticker', installed: true, backups: [older('0.1.0'), older('0.1.1')] }],
    });
    const view = await show();
    await button(row(view, 'ticker'), 'Remove')?.trigger('click');
    const panel = () => row(view, 'ticker').find('[data-remove]');
    await panel().find('input[name="deleteFiles"]').setValue(true);
    expect(panel().text()).toMatch(/No backup of this version is kept; 2 older backups remain/);
    expect(panel().text()).not.toMatch(/nothing to restore|no backup to restore/i);
    view.unmount();
  });

  it('asks separately before it removes a bundle that others need', async () => {
    more.push({
      name: 'crawl',
      state: 'running',
      version: '1.0.0',
      errors: [],
      panels: [],
      graphics: [],
      dependencies: ['ticker'],
    });
    const { calls, asked, confirms } = setup();
    const view = await show();
    const removeTicker = async () => {
      await button(row(view, 'ticker'), 'Remove')?.trigger('click');
      await button(row(view, 'ticker').find('[data-remove]'), 'Remove ticker')?.trigger('click');
      await flushPromises();
    };
    confirms.answer = false;
    await removeTicker();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/"ticker" is needed by crawl/);
    expect(calls.filter(({ method }) => method === 'POST')).toEqual([]);

    confirms.answer = true;
    await removeTicker();
    expect(calls.filter(({ method }) => method === 'POST').at(-1)).toEqual({
      method: 'POST',
      path: '/api/v1/bundles/ticker/remove',
      body: { force: true },
    });
    view.unmount();
  });

  it('shows why the server refused to remove it', async () => {
    const { answers } = setup();
    answers.set(
      'POST /api/v1/bundles/ticker/remove',
      new ApiError(409, 'conflict', 'Bundle "ticker" is needed by crawl'),
    );
    const view = await show();
    await button(row(view, 'ticker'), 'Remove')?.trigger('click');
    await button(row(view, 'ticker').find('[data-remove]'), 'Remove ticker')?.trigger('click');
    await flushPromises();
    expect(view.find('.install .problem').text()).toContain('needed by crawl');
    view.unmount();
  });

  it('turns the form into the update of the bundle, and back', async () => {
    setup();
    const view = await show();
    await button(row(view, 'board'), 'Update')?.trigger('click');
    const card = view.find('.install');
    expect(card.find('h2').text()).toBe('Update board');
    expect(
      button(card, 'Fetch from https://example.org/o/board.git at main (abcdef1)'),
    ).toBeDefined();
    await button(card, 'Cancel')?.trigger('click');
    expect(view.find('.install h2').text()).toBe('Install bundle');
    view.unmount();
  });

  it('fetches the update from where the bundle came from', async () => {
    const { calls } = setup();
    const view = await show();
    await button(row(view, 'board'), 'Update')?.trigger('click');
    await view
      .find('.install')
      .findAll('button')
      .find((item) => item.text().startsWith('Fetch from'))
      ?.trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: '/api/v1/bundles/board/update',
      body: {},
    });
    view.unmount();
  });

  it('takes another source for the update, naming the bundle it is for', async () => {
    const { calls, uploads, publish } = setup();
    const view = await show();
    // A bundle of unknown origin has nothing to fetch from by itself.
    await button(row(view, 'ticker'), 'Update')?.trigger('click');
    const card = view.find('.install');
    expect(card.findAll('button').some((item) => item.text().startsWith('Fetch from'))).toBe(false);
    await card.find('input[name="url"]').setValue('https://example.org/o/ticker.git');
    await card.find('form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)?.body).toEqual({
      source: { type: 'git', url: 'https://example.org/o/ticker.git' },
      target: 'ticker',
    });

    // Once that fetch is over, the form takes the next.
    publish({ jobs: [job('job-1', { state: 'failed', error: 'nothing there' })] });
    await flushPromises();
    await button(row(view, 'ticker'), 'Update')?.trigger('click');
    await choose(view, 'zip');
    const input = view.find('.install input[type="file"]');
    const file = new File(['zip'], 'ticker.zip');
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(uploads.at(-1)?.path).toBe('/api/v1/bundles/-/stage?filename=ticker.zip&target=ticker');
    view.unmount();
  });

  it('holds its buttons while something is being done to it', async () => {
    const { publish } = setup();
    const view = await show();
    publish({ jobs: [job('j', { operation: 'remove', bundle: 'ticker', step: 'erase' })] });
    await flushPromises();
    for (const label of ['Reload', 'Disable', 'Update', 'Remove']) {
      expect(button(row(view, 'ticker'), label)?.attributes('disabled')).toBeDefined();
      expect(button(row(view, 'board'), label)?.attributes('disabled')).toBeUndefined();
    }
    view.unmount();
  });

  it('stops following the installations when the page is left', async () => {
    const { stopped } = setup();
    const view = await show();
    view.unmount();
    // The update hints the page follows too.
    expect(stopped.sort()).toEqual(['system:installs', 'system:updates.bundles']);
  });

  it('draws everything without a style attribute, which the page policy would refuse', async () => {
    const { publish } = setup();
    const view = await show();
    publish({ jobs: [job('j', { step: 'fetch' })], staged: [STAGED] });
    await flushPromises();
    expect(view.html()).not.toMatch(/\sstyle=/);
    view.unmount();
  });
});

describe('what the review asked of the page', () => {
  const facts = (card: { findAll: VueWrapper['findAll'] }) =>
    Object.fromEntries(
      card.findAll('.facts > div').map((fact) => [fact.find('dt').text(), fact.find('dd').text()]),
    );
  async function staged(extra: object) {
    const context = setup();
    const view = await show();
    context.publish({ staged: [{ ...STAGED, ...extra }] });
    await flushPromises();
    return { ...context, view, card: view.find(`[data-staged="${STAGED.id}"]`) };
  }

  it('asks before a bundle is fetched whether it is trusted to run code while it is installed', async () => {
    const { calls } = setup();
    const view = await show();
    const trust = view.find('.install input[name="scripts"]');
    expect(trust.attributes('type')).toBe('checkbox');
    expect((trust.element as HTMLInputElement).checked).toBe(false);
    expect(trust.element.closest('label')?.textContent).toMatch(/run code while it is installed/);

    await trust.setValue(true);
    await view.find('.install input[name="url"]').setValue('https://example.org/o/clock.git');
    await view.find('.install form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)?.body).toEqual({
      source: { type: 'git', url: 'https://example.org/o/clock.git' },
      scripts: true,
    });
    view.unmount();

    // The same for an upload, and off again unless it is ticked again.
    setActivePinia(createPinia());
    const other = setup();
    const second = await show();
    await choose(second, 'zip');
    await second.find('.install input[name="scripts"]').setValue(true);
    const input = second.find('.install input[type="file"]');
    Object.defineProperty(input.element, 'files', {
      value: [new File(['zip'], 'clock.zip')],
      configurable: true,
    });
    await input.trigger('change');
    await flushPromises();
    expect(other.uploads.at(-1)?.path).toBe(
      '/api/v1/bundles/-/stage?filename=clock.zip&scripts=true',
    );
    second.unmount();
  });

  it('says of a trusted bundle what installing it runs, and installs it as it was fetched', async () => {
    const { view, card, calls } = await staged({
      installCode: 'allowed',
      npm: {
        ...STAGED.npm,
        config: ['.npmrc'],
        unusual: ['dependencies.repo: git+ssh://***@example.org/o/r.git'],
      },
    });
    expect(facts(card)['Runs code on install']).toBe(
      'Yes, as was allowed when it was fetched: it brings .npmrc; dependencies.repo: git+ssh://***@example.org/o/r.git; the install scripts of its npm packages',
    );
    expect(card.find('input[type="checkbox"]').exists()).toBe(false);
    await button(card, 'Install')?.trigger('click');
    await flushPromises();
    expect(calls.at(-1)?.body).toEqual({ scripts: true });
    view.unmount();
  });

  it('says of a bundle without npm packages that installing it runs nothing', async () => {
    const { view, card } = await staged({
      installCode: 'none',
      npm: {
        needed: false,
        lockfile: false,
        dependencies: [],
        installed: false,
        config: [],
        unusual: [],
      },
    });
    expect(facts(card)['Runs code on install']).toBe('No');
    view.unmount();
  });

  it('shows the role grants a bundle proposes and whether they will be made', async () => {
    const granted = await staged({
      roles: { grants: { operator: ['view', 'operate'], viewer: ['view'] }, applies: true },
    });
    expect(facts(granted.card)['Role grants']).toBe(
      'operator: view, operate; viewer: view (granted when it is installed)',
    );
    granted.view.unmount();
    const kept = await staged({ roles: { grants: { viewer: ['view'] }, applies: false } });
    expect(facts(kept.card)['Role grants']).toBe(
      'viewer: view (not granted: a bundle of this name was installed before, and the roles are as they were left)',
    );
    kept.view.unmount();
  });

  it('says that the files are deleted where no backups are kept, and offers no choice', async () => {
    kept.backups = 0;
    setup();
    const view = await show();
    await button(row(view, 'ticker'), 'Remove')?.trigger('click');
    const panel = row(view, 'ticker').find('[data-remove]');
    expect(panel.text()).toMatch(/files are deleted/);
    expect(panel.find('input[name="deleteFiles"]').exists()).toBe(false);
    view.unmount();
  });
});

describe('backups', () => {
  const backup = (version: string, day: string, reason: string) => ({
    id: `${version}-202611${day}T100000000Z`,
    version,
    time: `2026-11-${day}T10:00:00.000Z`,
    reason,
  });
  const BACKUPS = {
    bundles: [
      { name: 'gone', installed: false, backups: [backup('2.0.0', '20', 'remove')] },
      { name: 'ticker', installed: true, backups: [backup('0.1.0', '21', 'update')] },
    ],
  };
  const card = (view: VueWrapper) => view.find('[data-backups]');
  const entry = (view: VueWrapper, name: string) => card(view).find(`[data-backup-of="${name}"]`);

  it('lists the backups of every bundle, also of one that was removed', async () => {
    const { answers, calls } = setup();
    answers.set('GET /api/v1/bundles/-/backups', BACKUPS);
    const view = await show();
    expect(calls.some(({ path }) => path === '/api/v1/bundles/-/backups')).toBe(true);
    expect(entry(view, 'gone').text()).toContain('2.0.0');
    expect(entry(view, 'gone').text()).toContain('removed');
    expect(entry(view, 'ticker').text()).toContain('0.1.0');
    expect(entry(view, 'ticker').text()).toContain('before an update');
    view.unmount();
  });

  it('says so when there is no backup', async () => {
    const { answers } = setup();
    answers.set('GET /api/v1/bundles/-/backups', { bundles: [] });
    const view = await show();
    expect(card(view).text()).toContain('No backups');
    view.unmount();
  });

  it('restores one after a question that says what happens to the installed version', async () => {
    const { answers, asked, confirms, calls } = setup();
    answers.set('GET /api/v1/bundles/-/backups', BACKUPS);
    const view = await show();
    const posts = () => calls.filter(({ method }) => method === 'POST');

    confirms.answer = false;
    await button(entry(view, 'ticker'), 'Restore')?.trigger('click');
    await flushPromises();
    expect(asked[0]).toMatch(/^Restore "ticker" 0\.1\.0/);
    expect(asked[0]).toMatch(/installed version 0\.2\.0 is stopped and moved to the backups/);
    // The backup is put in place: it is gone from the list afterwards.
    expect(asked[0]).toMatch(/This backup is used up/);
    expect(posts()).toEqual([]);

    confirms.answer = true;
    await button(entry(view, 'gone'), 'Restore')?.trigger('click');
    await flushPromises();
    expect(asked[1]).toMatch(/installed again/);
    expect(posts().at(-1)).toEqual({
      method: 'POST',
      path: '/api/v1/bundles/gone/backups/2.0.0-20261120T100000000Z/restore',
      body: {},
    });
    view.unmount();
  });

  it('keeps the newest list when an earlier request answers last', async () => {
    setup();
    const installs = useInstalls();
    const pending: ((value: unknown) => void)[] = [];
    api.request = vi.fn(
      () => new Promise((resolve) => pending.push(resolve)),
    ) as unknown as typeof api.request;
    const first = installs.loadBackups();
    const second = installs.loadBackups();
    pending[1]?.(BACKUPS);
    await second;
    pending[0]?.({ bundles: [] });
    await first;
    expect(installs.backups.map((of) => of.name)).toEqual(['gone', 'ticker']);
  });

  it('shows why the list could not be read in the card, apart from the jobs', async () => {
    const { answers } = setup();
    answers.set(
      'GET /api/v1/bundles/-/backups',
      new ApiError(500, 'internal', 'The backups could not be read'),
    );
    const view = await show();
    expect(card(view).find('.problem').text()).toContain('The backups could not be read');
    expect(useInstalls().problem).toBe('');
    view.unmount();
  });

  it('is not shown to those who may not manage bundles', async () => {
    const { calls } = setup(false);
    const view = await show();
    expect(card(view).exists()).toBe(false);
    expect(calls.some(({ path }) => path.endsWith('/backups'))).toBe(false);
    view.unmount();
  });
});
