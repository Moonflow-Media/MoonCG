import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/kernel/config.js';
import type { ServerOptions } from '../src/server.js';
import { type AuthServer, authBundles, PASSWORD, startAuthServer } from './auth-helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
let context: AuthServer | undefined;
let dataDir = '';
const cookies: Record<string, string> = {};

afterEach(async () => {
  await context?.server.close();
  context = undefined;
  await temporary.cleanup();
});

const MAX_FILE = 1000;
const QUOTA = 2500;

/**
 * A bundle with a category of images only operators may change, one that takes anything,
 * and one that says nothing about who may write it.
 */
async function start(
  config: Partial<ServerConfig> = {},
  options: Partial<ServerOptions> = {},
  before: (dataDir: string) => Promise<unknown> = async () => {},
): Promise<AuthServer> {
  const bundles: Record<string, string | object> = authBundles();
  delete bundles['board/extension/index.js'];
  bundles['board/mooncg.json'] = manifest('board', {
    title: 'Board',
    permissions: { view: 'See the board', operate: 'Change the board' },
    defaultRoles: { operator: ['view', 'operate'], viewer: ['view'] },
    assets: [
      { id: 'logos', title: 'Logos', accept: ['image/*'], read: 'view', write: 'operate' },
      { id: 'misc', write: 'operate' },
      { id: 'open' },
    ],
  });
  dataDir = await temporary.create({});
  await before(dataDir);
  const started = await startAuthServer(
    temporary,
    {
      bundlesDir: await temporary.create(bundles),
      dataDir,
      assetMaxFileBytes: MAX_FILE,
      assetQuotaBytes: QUOTA,
      ...config,
    },
    options,
  );
  context = started;
  const users = { admin: 'ada', operator: 'olga', viewer: 'vera', nobody: 'nora' };
  for (const [role, name] of Object.entries(users)) {
    await started.auth.createUser({
      name,
      password: PASSWORD,
      roles: role === 'nobody' ? [] : [role],
    });
    cookies[role] = await started.login(name);
  }
  return started;
}

const cookie = (role: string) => ({ cookie: cookies[role] as string });
const api = (category: string, file?: string) =>
  `/api/v1/bundles/board/assets/${category}${file === undefined ? '' : `/${file}`}`;
const UPLOAD = { 'content-type': 'application/octet-stream', 'x-mooncg-csrf': '1' };

const upload = (server: AuthServer, role: string, category: string, file: string, body = 'PNG') =>
  server.http('PUT', api(category, file), { ...cookie(role), body, headers: UPLOAD });
const names = async (server: AuthServer, category = 'logos', role = 'operator') =>
  (await server.http('GET', api(category), cookie(role))).json.files.map(
    (file: { name: string }) => file.name,
  );
/** Every file below the data directory, as paths with forward slashes. */
async function stored(): Promise<string[]> {
  const entries = await readdir(dataDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dataDir.length + 1))
    .map((path) => path.replaceAll('\\', '/'))
    .sort();
}
/** A request whose path goes out exactly as written, which `fetch` would tidy up first. */
function raw(server: AuthServer, method: string, path: string, role: string, body?: string) {
  return new Promise<number>((resolve, reject) => {
    const sent = httpRequest(
      {
        host: '127.0.0.1',
        port: server.server.port,
        method,
        path,
        headers: { ...cookie(role), ...UPLOAD },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    sent.on('error', reject);
    sent.end(body);
  });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
/** A body of `count` pieces of `size` bytes that does not say beforehand how long it is. */
function chunks(count: number, size: number): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode('x'.repeat(size));
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < count) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

describe('uploading an asset', () => {
  it('stores the file in the data directory, lists it and serves it', async () => {
    const server = await start();
    expect(await names(server)).toEqual([]);

    const answer = await upload(server, 'operator', 'logos', 'home.png', 'PNG-BYTES');
    expect(answer.status).toBe(201);
    expect(answer.json).toEqual({
      file: {
        name: 'home.png',
        size: 9,
        modified: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        url: '/b/board/assets/logos/home.png',
      },
    });
    expect(await stored()).toEqual(['assets/board/logos/home.png']);
    expect(await readFile(join(dataDir, 'assets/board/logos/home.png'), 'utf8')).toBe('PNG-BYTES');

    const list = await server.http('GET', api('logos'), cookie('viewer'));
    expect(list.json).toEqual({
      files: [answer.json.file],
      used: 9,
      limits: { maxFileBytes: MAX_FILE, quotaBytes: QUOTA, maxFiles: 1000 },
    });

    const served = await server.http('GET', '/b/board/assets/logos/home.png', cookie('viewer'));
    expect(served.status).toBe(200);
    expect(served.text).toBe('PNG-BYTES');
    expect(served.headers.get('content-type')).toBe('image/png');
  });

  it('takes a name that differs only in case for the same file, under its new spelling', async () => {
    const server = await start();
    await upload(server, 'operator', 'logos', 'home.png', 'old');
    expect((await upload(server, 'operator', 'logos', 'HOME.png', 'newer')).status).toBe(201);
    expect(await names(server)).toEqual(['HOME.png']);
    expect(await stored()).toEqual(['assets/board/logos/HOME.png']);
    const served = await server.http('GET', '/b/board/assets/logos/HOME.png', cookie('viewer'));
    expect(served.text).toBe('newer');
  });

  it('says that the server failed, not the upload, when the file cannot be put in place', async () => {
    // Something that is no file is in the way of the name.
    const server = await start({}, {}, (dir) =>
      mkdir(join(dir, 'assets/board/logos/blocked.png/inside'), { recursive: true }),
    );
    await upload(server, 'operator', 'logos', 'home.png', 'kept');
    const answer = await upload(server, 'operator', 'logos', 'blocked.png');
    expect(answer.status).toBe(500);
    expect(answer.json.error).toEqual({
      code: 'internal',
      message: 'The file could not be stored',
    });
    expect(await stored()).toEqual(['assets/board/logos/home.png']);
  });

  it('clears away what interrupted uploads left behind when it starts', async () => {
    await start({}, {}, async (dir) => {
      await mkdir(join(dir, 'assets/.incoming'), { recursive: true });
      await writeFile(join(dir, 'assets/.incoming/left-over'), 'half a file');
    });
    expect(await stored()).toEqual([]);
  });

  it('replaces a file of the same name', async () => {
    const server = await start();
    await upload(server, 'operator', 'logos', 'home.png', 'old');
    expect((await upload(server, 'operator', 'logos', 'home.png', 'newer')).status).toBe(201);
    expect(await names(server)).toEqual(['home.png']);
    const served = await server.http('GET', '/b/board/assets/logos/home.png', cookie('viewer'));
    expect(served.text).toBe('newer');
  });

  it('is for whoever holds what the category asks for writing', async () => {
    const server = await start();
    expect((await upload(server, 'viewer', 'logos', 'a.png')).status).toBe(403);
    expect((await upload(server, 'nobody', 'logos', 'a.png')).status).toBe(404);
    const anonymous = await server.http('PUT', api('logos', 'a.png'), {
      body: 'x',
      headers: UPLOAD,
    });
    expect(anonymous.status).toBe(401);
    expect((await upload(server, 'operator', 'nothing', 'a.png')).status).toBe(404);
    expect(await stored()).toEqual([]);
  });

  it('takes system:bundles.manage where the category names no permission to write', async () => {
    const server = await start();
    // Reading such a category takes any permission of the bundle; changing it takes more.
    expect((await server.http('GET', api('open'), cookie('viewer'))).status).toBe(200);
    expect((await upload(server, 'viewer', 'open', 'notes.txt')).status).toBe(403);
    expect((await upload(server, 'operator', 'open', 'notes.txt')).status).toBe(403);
    expect(await stored()).toEqual([]);
    expect((await upload(server, 'admin', 'open', 'notes.txt')).status).toBe(201);
    const remove = (role: string) =>
      server.http('DELETE', api('open', 'notes.txt'), { ...cookie(role), json: {} });
    expect((await remove('operator')).status).toBe(403);
    expect((await remove('admin')).status).toBe(204);
  });

  it('needs the header that proves the page meant it, because an upload is no JSON', async () => {
    const server = await start();
    const bare = await server.http('PUT', api('logos', 'a.png'), {
      ...cookie('operator'),
      body: 'PNG',
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(bare.status).toBe(403);
    expect(bare.json.error.message).toContain('X-MoonCG-CSRF');
    const foreign = await server.http('PUT', api('logos', 'a.png'), {
      ...cookie('operator'),
      body: 'PNG',
      headers: { ...UPLOAD, origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    expect(await stored()).toEqual([]);
  });
});

describe('the limits of an upload', () => {
  it('refuses a file over the size limit', async () => {
    const server = await start();
    expect((await upload(server, 'operator', 'logos', 'ok.png', 'x'.repeat(MAX_FILE))).status).toBe(
      201,
    );
    const answer = await upload(server, 'operator', 'logos', 'big.png', 'x'.repeat(MAX_FILE + 1));
    expect(answer.status).toBe(413);
    expect(answer.json.error.message).toContain(`${MAX_FILE} bytes`);
    expect(await stored()).toEqual(['assets/board/logos/ok.png']);
  });

  it('counts what arrives when the request does not say how long it is', async () => {
    const server = await start();
    const response = await fetch(`${server.base}${api('logos', 'stream.png')}`, {
      method: 'PUT',
      headers: { ...cookie('operator'), ...UPLOAD },
      body: chunks(3, 400),
      duplex: 'half',
    } as RequestInit).catch(() => undefined);
    // The server may answer or cut the connection; either way nothing is kept.
    if (response) expect(response.status).toBe(413);
    await tick();
    expect(await stored()).toEqual([]);
  });

  it('counts what arrives against the quota as well', async () => {
    const server = await start();
    const file = 'x'.repeat(900);
    await upload(server, 'operator', 'logos', 'a.png', file);
    await upload(server, 'operator', 'logos', 'b.png', file);
    // 900 more bytes fit a file, but not the 700 the category has left.
    const response = await fetch(`${server.base}${api('logos', 'c.png')}`, {
      method: 'PUT',
      headers: { ...cookie('operator'), ...UPLOAD },
      body: chunks(3, 300),
      duplex: 'half',
    } as RequestInit).catch(() => undefined);
    if (response) expect(response.status).toBe(413);
    await tick();
    expect(await names(server)).toEqual(['a.png', 'b.png']);
    expect((await stored()).filter((path) => path.includes('.incoming'))).toEqual([]);
  });

  it('refuses what would take a category over its quota', async () => {
    const server = await start();
    const file = 'x'.repeat(900);
    expect((await upload(server, 'operator', 'logos', 'a.png', file)).status).toBe(201);
    expect((await upload(server, 'operator', 'logos', 'b.png', file)).status).toBe(201);
    const over = await upload(server, 'operator', 'logos', 'c.png', file);
    expect(over.status).toBe(413);
    expect(over.json.error.message).toContain(`${QUOTA} bytes`);
    expect(await names(server)).toEqual(['a.png', 'b.png']);
    // Replacing a file frees what it took, and another category has a quota of its own.
    expect((await upload(server, 'operator', 'logos', 'a.png', file)).status).toBe(201);
    expect((await upload(server, 'operator', 'misc', 'c.png', file)).status).toBe(201);
  });

  it('refuses a new file once the category holds as many as it may', async () => {
    const server = await start({ assetMaxFiles: 2 });
    expect((await upload(server, 'operator', 'logos', 'a.png')).status).toBe(201);
    expect((await upload(server, 'operator', 'logos', 'b.png')).status).toBe(201);
    const third = await upload(server, 'operator', 'logos', 'c.png');
    expect(third.status).toBe(413);
    expect(third.json.error.message).toContain('at most 2 files');
    expect(await stored()).toEqual(['assets/board/logos/a.png', 'assets/board/logos/b.png']);
    // Replacing one of them adds none.
    expect((await upload(server, 'operator', 'logos', 'a.png', 'new')).status).toBe(201);
  });

  it('does not let an upload that stalls hold up the category, and gives up on it', async () => {
    const server = await start({}, { assetUploadIdleMs: 600 });
    // An upload that sends a little and then nothing more.
    const stalled = new Promise<number>((resolve, reject) => {
      const sent = httpRequest(
        {
          host: '127.0.0.1',
          port: server.server.port,
          method: 'PUT',
          path: api('logos', 'slow.png'),
          headers: { ...cookie('operator'), ...UPLOAD, 'content-length': '500' },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      sent.on('error', reject);
      sent.write('only the start');
    });
    await tick();
    const began = Date.now();
    expect((await upload(server, 'operator', 'logos', 'quick.png')).status).toBe(201);
    expect(Date.now() - began).toBeLessThan(500);
    expect(await stalled).toBe(408);
    await tick();
    expect(await stored()).toEqual(['assets/board/logos/quick.png']);
  });

  it('takes only what the category accepts', async () => {
    const server = await start();
    const page = await upload(server, 'operator', 'logos', 'page.html', '<script>1</script>');
    expect(page.status).toBe(415);
    expect((await upload(server, 'operator', 'logos', 'notes.txt')).status).toBe(415);
    expect((await upload(server, 'operator', 'logos', 'logo.svg', '<svg/>')).status).toBe(201);
    expect(await names(server)).toEqual(['logo.svg']);
  });
});

describe('the name of an uploaded file', () => {
  it('is cleaned, and the answer says what it became', async () => {
    const server = await start();
    const device = await upload(server, 'operator', 'logos', 'CON.png');
    expect(device.json.file.name).toBe('_CON.png');
    const dots = await upload(server, 'operator', 'logos', encodeURIComponent('away.png. .'));
    expect(dots.json.file.name).toBe('away.png');
    const odd = await upload(server, 'operator', 'logos', encodeURIComponent('a<b>:c.png'));
    expect(odd.json.file.name).toBe('a_b__c.png');
    expect(odd.json.file.url).toBe('/b/board/assets/logos/a_b__c.png');
    expect(await names(server)).toEqual(['_CON.png', 'a_b__c.png', 'away.png']);
    expect((await upload(server, 'operator', 'misc', 'NUL')).json.file.name).toBe('_NUL');
  });

  it.each([
    ['..%2F..%2Fescape.png'],
    ['..%5C..%5Cescape.png'],
    ['%2E%2E%2Fescape.png'],
    ['..'],
    ['%2E%2E'],
    ['../../escape.png'],
    ['..%2F..%2F..%2Fconfig%2Fboard.json'],
    ['a%00.png'],
  ])('never leaves the folder of the category: %s', async (file) => {
    const server = await start();
    const status = await raw(server, 'PUT', api('logos', file), 'operator', 'PNG');
    expect([400, 404]).toContain(status);
    expect(await stored()).toEqual([]);
  });
});

describe('serving an asset', () => {
  it('is for whoever holds what the category asks for reading', async () => {
    const server = await start();
    await upload(server, 'operator', 'logos', 'home.png');
    const get = (role?: string) =>
      server.http('GET', '/b/board/assets/logos/home.png', role === undefined ? {} : cookie(role));
    expect((await get('viewer')).status).toBe(200);
    expect((await get('nobody')).status).toBe(404);
    expect((await get()).status).toBe(401);
    expect((await server.http('GET', api('logos'), cookie('nobody'))).status).toBe(404);
    expect((await server.http('GET', api('logos'))).status).toBe(401);
  });

  it('answers 404 for what is not there, also outside the folder of the category', async () => {
    const server = await start();
    await upload(server, 'operator', 'logos', 'home.png');
    const paths = [
      '/b/board/assets/logos/missing.png',
      '/b/board/assets/nothing/home.png',
      '/b/board/assets/logos',
      '/b/board/assets/logos/../../../mooncg.db',
      '/b/board/assets/logos/..%2Fmisc%2Fx',
      '/b/board/assets/logos/%2E%2E/logos/home.png',
      '/b/board/assets/logos/HOME.PNG',
    ];
    for (const path of paths) {
      expect(await raw(server, 'GET', path, 'operator'), path).toBe(404);
    }
  });

  it('serves a part of a file when asked for a range, as players of video do', async () => {
    const server = await start();
    await upload(server, 'operator', 'logos', 'clip.png', '0123456789');
    const get = (range?: string) =>
      server.http('GET', '/b/board/assets/logos/clip.png', {
        ...cookie('viewer'),
        ...(range === undefined ? {} : { headers: { range } }),
      });

    const whole = await get();
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('content-length')).toBe('10');

    const part = await get('bytes=2-5');
    expect(part.status).toBe(206);
    expect(part.text).toBe('2345');
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(part.headers.get('content-length')).toBe('4');
    expect(part.headers.get('content-type')).toBe('image/png');
    expect(part.headers.get('content-security-policy')).toMatch(/^sandbox;/);

    expect(await get('bytes=7-')).toMatchObject({ status: 206, text: '789' });
    const suffix = await get('bytes=-3');
    expect(suffix).toMatchObject({ status: 206, text: '789' });
    expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10');
    // An end beyond the file is cut to the file; a suffix longer than the file is all of it.
    expect(await get('bytes=8-100')).toMatchObject({ status: 206, text: '89' });
    expect(await get('bytes=-100')).toMatchObject({ status: 206, text: '0123456789' });

    for (const range of ['bytes=10-', 'bytes=100-200', 'bytes=-0']) {
      const beyond = await get(range);
      expect(beyond.status, range).toBe(416);
      expect(beyond.headers.get('content-range')).toBe('bytes */10');
    }
    // What is no single range of bytes is not understood, and answered with the whole file.
    for (const range of ['bytes=5-2', 'items=1-2', 'bytes=1-2,4-5', 'bytes=a-b']) {
      expect(await get(range), range).toMatchObject({ status: 200, text: '0123456789' });
    }
  });

  it('never serves an upload as a page or a script of this server', async () => {
    const server = await start();
    const script = '<script>document.title = "ran"</script>';
    await upload(server, 'operator', 'misc', 'page.html', script);
    await upload(server, 'operator', 'misc', 'code.js', 'alert(1)');
    await upload(
      server,
      'operator',
      'logos',
      'logo.svg',
      `<svg xmlns="http://www.w3.org/2000/svg">${script}</svg>`,
    );

    for (const file of ['page.html', 'code.js']) {
      const served = await server.http('GET', `/b/board/assets/misc/${file}`, cookie('operator'));
      expect(served.headers.get('content-type')).toBe('application/octet-stream');
      expect(served.headers.get('content-disposition')).toMatch(/^attachment/);
      expect(served.headers.get('x-content-type-options')).toBe('nosniff');
      expect(served.headers.get('content-security-policy')).toMatch(/^sandbox;/);
    }
    // An SVG stays an image a graphic can show, in a document that runs nothing.
    const svg = await server.http('GET', '/b/board/assets/logos/logo.svg', cookie('operator'));
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
    const policy = svg.headers.get('content-security-policy') ?? '';
    expect(policy).toMatch(/^sandbox;/);
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('allow-scripts');
  });

  it('goes by the name of the file, not by what the upload said it was', async () => {
    const server = await start();
    await server.http('PUT', api('logos', 'fake.png'), {
      ...cookie('operator'),
      body: '<script>1</script>',
      headers: { ...UPLOAD, 'content-type': 'text/html' },
    });
    const served = await server.http('GET', '/b/board/assets/logos/fake.png', cookie('operator'));
    expect(served.headers.get('content-type')).toBe('image/png');
  });
});

describe('deleting an asset', () => {
  it('removes the file for whoever may write the category', async () => {
    const server = await start();
    await upload(server, 'operator', 'logos', 'home.png');
    const remove = (role: string, file = 'home.png') =>
      server.http('DELETE', api('logos', file), { ...cookie(role), json: {} });
    expect((await remove('viewer')).status).toBe(403);
    expect((await remove('nobody')).status).toBe(404);
    expect(await names(server)).toEqual(['home.png']);
    expect((await remove('operator')).status).toBe(204);
    expect(await names(server)).toEqual([]);
    expect(await stored()).toEqual([]);
    expect((await remove('operator')).status).toBe(404);
    expect((await remove('operator', '..%2Fx')).status).toBe(404);
  });
});

describe('the list of a category', () => {
  it('is a read-only replicant that follows uploads and deletions', async () => {
    const server = await start();
    const socket = await server.socket(cookie('viewer'), 'board');
    const first = await socket.ask({ t: 'rep.sub', name: '$assets.logos' });
    expect(first).toMatchObject({ t: 'rep.snap', value: [] });

    const uploaded = await upload(server, 'operator', 'logos', 'home.png');
    await tick();
    expect(socket.pushed).toHaveLength(1);
    const again = await server.socket(cookie('viewer'), 'board');
    expect(await again.ask({ t: 'rep.sub', name: '$assets.logos' })).toMatchObject({
      value: [uploaded.json.file],
    });

    await server.http('DELETE', api('logos', 'home.png'), { ...cookie('operator'), json: {} });
    await tick();
    expect(socket.pushed).toHaveLength(2);

    const write = await again.ask({
      t: 'rep.op',
      name: '$assets.logos',
      patches: [{ op: 'replace', path: '', value: [] }],
    });
    expect(write).toMatchObject({ t: 'err', code: 'forbidden' });
    socket.close();
    again.close();
  });

  it('is told only to those who may read the category', async () => {
    const server = await start();
    // Someone who holds a permission of the bundle, but not the one the category asks for.
    server.auth.createRole('changer', ['bundle:board:operate']);
    await server.auth.createUser({ name: 'chad', password: PASSWORD, roles: ['changer'] });
    const socket = await server.socket({ cookie: await server.login('chad') }, 'board');
    expect(await socket.ask({ t: 'rep.sub', name: '$assets.logos' })).toMatchObject({
      t: 'err',
      code: 'forbidden',
    });
    expect(await socket.ask({ t: 'rep.sub', name: '$assets.misc' })).toMatchObject({
      t: 'rep.snap',
    });
    socket.close();
    const chad = { cookie: await server.login('chad') };
    expect((await server.http('GET', api('logos'), chad)).status).toBe(403);
    // Nor are the files themselves served to them.
    await upload(server, 'operator', 'logos', 'home.png');
    expect((await server.http('GET', '/b/board/assets/logos/home.png', chad)).status).toBe(403);
  });

  it('still lists what is stored after the bundle was reloaded', async () => {
    const server = await start();
    await upload(server, 'operator', 'logos', 'home.png');
    await server.server.manager.reload('board');
    const socket = await server.socket(cookie('viewer'), 'board');
    expect(await socket.ask({ t: 'rep.sub', name: '$assets.logos' })).toMatchObject({
      value: [{ name: 'home.png' }],
    });
    socket.close();
  });

  it('comes with the bundle, with what the caller may do', async () => {
    const server = await start();
    const assetsFor = async (role: string) => {
      const answer = await server.http('GET', '/api/v1/bundles', cookie(role));
      return answer.json.bundles.find((bundle: { name: string }) => bundle.name === 'board').assets;
    };
    expect(await assetsFor('operator')).toEqual([
      { id: 'logos', title: 'Logos', accept: ['image/*'], canWrite: true },
      { id: 'misc', canWrite: true },
      { id: 'open', canWrite: false },
    ]);
    expect(await assetsFor('viewer')).toEqual([
      { id: 'logos', title: 'Logos', accept: ['image/*'], canWrite: false },
      { id: 'misc', canWrite: false },
      { id: 'open', canWrite: false },
    ]);
    expect((await assetsFor('admin'))[2]).toEqual({ id: 'open', canWrite: true });
  });
});
