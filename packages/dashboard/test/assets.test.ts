// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api.js';
import { live } from '../src/live.js';
import { AssetsView } from '../src/views/Assets.js';

const BUNDLES = {
  canManage: false,
  bundles: [
    {
      name: 'board',
      title: 'Board',
      state: 'running',
      errors: [],
      panels: [],
      graphics: [],
      assets: [
        { id: 'logos', title: 'Logos', accept: ['image/*', '.svg'], canWrite: true },
        { id: 'sounds', canWrite: false },
      ],
    },
    { name: 'plain', state: 'running', errors: [], panels: [], graphics: [], assets: [] },
  ],
};
const HOME = {
  name: 'home team.png',
  size: 2048,
  modified: '2026-01-02T03:04:05.000Z',
  url: '/b/board/assets/logos/home%20team.png',
};

/** The real one, before the tests below put their own in its place. */
const realUpload = api.upload;

type Listener = (value: unknown) => void;
type Call = { method: string; path: string };

function setup() {
  const followed = new Map<string, Listener>();
  const stopped: string[] = [];
  live.follow = ((name: string, listener: Listener) => {
    followed.set(name, listener);
    return () => stopped.push(name);
  }) as typeof live.follow;
  const calls: Call[] = [];
  api.request = vi.fn(async (method: string, path: string) => {
    calls.push({ method, path });
    if (path === '/api/v1/bundles') return structuredClone(BUNDLES);
    return undefined;
  }) as typeof api.request;
  const uploads: { path: string; name: string }[] = [];
  api.upload = vi.fn(async (path: string, file: Blob) => {
    uploads.push({ path, name: (file as File).name });
    return { file: HOME };
  }) as typeof api.upload;
  return { followed, stopped, calls, uploads };
}

/** Puts files into a file input as a person choosing them would. */
async function choose(input: ReturnType<ReturnType<typeof mount>['find']>, files: File[]) {
  Object.defineProperty(input.element, 'files', { value: files, configurable: true });
  await input.trigger('change');
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => vi.unstubAllGlobals());

describe('the assets page', () => {
  it('shows each category of each bundle and follows its list of files', async () => {
    const { followed, stopped } = setup();
    const view = mount(AssetsView);
    await flushPromises();
    expect([...followed.keys()]).toEqual(['board:$assets.logos', 'board:$assets.sounds']);
    expect(view.find('[data-category="board:logos"] h3').text()).toBe('Logos');
    // Nothing is claimed about a list before the server has told it.
    expect(view.find('[data-category="board:logos"]').text()).not.toContain('No files yet');
    followed.get('board:$assets.logos')?.([]);
    await flushPromises();
    expect(view.find('[data-category="board:logos"]').text()).toContain('No files yet');

    followed.get('board:$assets.logos')?.([HOME]);
    await flushPromises();
    const row = view.find('[data-asset="home team.png"]');
    expect(row.find('a').attributes('href')).toBe('/b/board/assets/logos/home%20team.png');
    expect(row.text()).toContain('2.0 KiB');

    view.unmount();
    expect(stopped).toEqual(['board:$assets.logos', 'board:$assets.sounds']);
  });

  it('offers upload and delete only where the user may write', async () => {
    const { followed } = setup();
    const view = mount(AssetsView);
    await flushPromises();
    followed.get('board:$assets.logos')?.([HOME]);
    followed.get('board:$assets.sounds')?.([{ ...HOME, name: 'horn.mp3' }]);
    await flushPromises();
    const logos = view.find('[data-category="board:logos"]');
    expect(logos.find('input[type="file"]').attributes('accept')).toBe('image/*,.svg');
    expect(logos.find('[data-asset="home team.png"] button').exists()).toBe(true);
    const sounds = view.find('[data-category="board:sounds"]');
    expect(sounds.find('input[type="file"]').exists()).toBe(false);
    expect(sounds.find('button').exists()).toBe(false);
  });

  it('uploads each chosen file under its name', async () => {
    const { uploads } = setup();
    const view = mount(AssetsView);
    await flushPromises();
    await choose(view.find('[data-category="board:logos"] input[type="file"]'), [
      new File(['a'], 'home team.png'),
      new File(['b'], 'away.svg'),
    ]);
    expect(uploads).toEqual([
      { path: '/api/v1/bundles/board/assets/logos/home%20team.png', name: 'home team.png' },
      { path: '/api/v1/bundles/board/assets/logos/away.svg', name: 'away.svg' },
    ]);
  });

  it('says why an upload was refused, and under which name a file was stored', async () => {
    setup();
    api.upload = vi.fn(async (_path: string, file: Blob) => {
      if ((file as File).name === 'big.png') {
        throw new ApiError(413, 'bad_request', 'A file may have at most 1000 bytes');
      }
      return { file: { ...HOME, name: '_CON.png' } };
    }) as typeof api.upload;
    const view = mount(AssetsView);
    await flushPromises();
    const input = view.find('[data-category="board:logos"] input[type="file"]');
    await choose(input, [new File(['a'], 'big.png'), new File(['b'], 'CON.png')]);
    const text = view.find('[data-category="board:logos"]').text();
    expect(text).toContain('big.png: A file may have at most 1000 bytes');
    expect(text).toContain('CON.png was stored as _CON.png');
  });

  it('deletes a file after asking', async () => {
    const { followed, calls } = setup();
    const view = mount(AssetsView);
    await flushPromises();
    followed.get('board:$assets.logos')?.([HOME]);
    await flushPromises();
    await view.find('[data-asset="home team.png"] button').trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toEqual({
      method: 'DELETE',
      path: '/api/v1/bundles/board/assets/logos/home%20team.png',
    });
  });

  it('says so when no bundle takes assets', async () => {
    setup();
    api.request = vi.fn(async () => ({ canManage: false, bundles: [] })) as typeof api.request;
    const view = mount(AssetsView);
    await flushPromises();
    expect(view.text()).toContain('No bundle takes assets');
  });
});

describe('api.upload', () => {
  it('sends the file as the body, with the header the server asks of an upload', async () => {
    const fetched = vi.fn(async (_path: string, _init: RequestInit) => ({
      ok: true,
      status: 201,
      json: async () => ({ file: HOME }),
    }));
    vi.stubGlobal('fetch', fetched);
    const file = new File(['abc'], 'a.png');
    expect(await realUpload('/api/v1/bundles/board/assets/logos/a.png', file)).toEqual({
      file: HOME,
    });
    const [path, init] = fetched.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/bundles/board/assets/logos/a.png');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(file);
    expect(init.headers).toEqual({
      'content-type': 'application/octet-stream',
      'x-mooncg-csrf': '1',
    });
  });
});
