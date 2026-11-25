import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addressProblem, download, getJson, isJsonType } from '../src/registry/https.js';
import { bytes, type HttpFixture, json, redirect, startHttpFixture } from './http-fixture.js';

const fixtures: HttpFixture[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function serve(routes: Parameters<typeof startHttpFixture>[0]) {
  const fixture = await startHttpFixture(routes);
  fixtures.push(fixture);
  return fixture;
}
const OPTIONS = { timeoutMs: 2000, maxBytes: 1024 };

describe('getJson', () => {
  it('reads JSON and the validators for a conditional request', async () => {
    const server = await serve({
      '/index.json': json({ index: 1 }, { etag: '"v1"', 'last-modified': 'Tue, 24 Nov 2026' }),
    });
    const got = await getJson(`${server.url}/index.json`, OPTIONS);
    expect(got).toEqual({
      status: 'ok',
      value: { index: 1 },
      etag: '"v1"',
      lastModified: 'Tue, 24 Nov 2026',
    });
  });

  it('sends the validators it is given and takes 304 as not modified', async () => {
    const server = await serve({
      '/index.json': (request, response) => {
        if (request.headers['if-none-match'] === '"v1"') response.writeHead(304).end();
        else json({ index: 1 })(request, response);
      },
    });
    const got = await getJson(`${server.url}/index.json`, { ...OPTIONS, etag: '"v1"' });
    expect(got).toEqual({ status: 'not-modified' });
  });

  it('refuses a wrong content type, an error status and what is no JSON', async () => {
    const server = await serve({
      '/html': (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
      },
      '/gone': (_request, response) => response.writeHead(410).end(),
      '/broken': json('{ not json'),
    });
    await expect(getJson(`${server.url}/html`, OPTIONS)).rejects.toThrow(/content type/);
    await expect(getJson(`${server.url}/gone`, OPTIONS)).rejects.toThrow(/410/);
    await expect(getJson(`${server.url}/broken`, OPTIONS)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses what is larger than allowed, also when it does not say how large it is', async () => {
    const server = await serve({
      '/declared': json('x'.repeat(2000)),
      '/streamed': (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        // Sent in pieces without a length: it is counted as it arrives.
        let sent = 0;
        const timer = setInterval(() => {
          response.write('x'.repeat(300));
          sent++;
          if (sent === 10) {
            clearInterval(timer);
            response.end();
          }
        }, 5);
      },
    });
    await expect(getJson(`${server.url}/declared`, OPTIONS)).rejects.toThrow(/larger than 1024/);
    await expect(getJson(`${server.url}/streamed`, OPTIONS)).rejects.toThrow(/larger than 1024/);
  });

  it('follows a few redirects, each checked again, and no loop', async () => {
    const server = await serve({ '/index.json': json({ index: 1 }) });
    server.routes.set('/a', redirect(`${server.url}/b`));
    server.routes.set('/b', redirect('/index.json', 301));
    expect(await getJson(`${server.url}/a`, OPTIONS)).toMatchObject({ value: { index: 1 } });

    server.routes.set('/loop', redirect('/loop'));
    await expect(getJson(`${server.url}/loop`, OPTIONS)).rejects.toThrow(/redirect/);

    // Plain http elsewhere than this machine is never asked, not even after a redirect.
    server.routes.set('/away', redirect('http://example.invalid/index.json'));
    await expect(getJson(`${server.url}/away`, OPTIONS)).rejects.toThrow(/https/);
    server.routes.set('/file', redirect('file:///etc/passwd'));
    await expect(getJson(`${server.url}/file`, OPTIONS)).rejects.toThrow(/https/);
  });

  it('gives up after the timeout', async () => {
    const server = await serve({ '/slow': () => {} });
    await expect(
      getJson(`${server.url}/slow`, { ...OPTIONS, timeoutMs: 150 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('sends credentials of the address as a header, to its own origin only, and never says them', async () => {
    const other = await serve({ '/index.json': json({ index: 1 }) });
    const server = await serve({
      '/private.json': json({ index: 1 }),
      '/elsewhere': redirect(`${other.url}/index.json`),
      '/denied': (_request, response) => response.writeHead(401).end(),
    });
    const host = server.url.replace('http://', '');
    await getJson(`http://reader:s3cret@${host}/private.json`, OPTIONS);
    const sent = server.requests.at(-1)?.headers.authorization;
    expect(sent).toBe(`Basic ${Buffer.from('reader:s3cret').toString('base64')}`);

    await getJson(`http://reader:s3cret@${host}/elsewhere`, OPTIONS);
    expect(other.requests.at(-1)?.headers.authorization).toBeUndefined();

    const error = await getJson(`http://reader:s3cret@${host}/denied`, OPTIONS).catch(
      (caught: Error) => caught,
    );
    expect(String(error)).toMatch(/401/);
    expect(String(error)).not.toMatch(/s3cret/);
  });

  it('knows which content types are JSON', () => {
    expect(isJsonType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonType('application/vnd.mooncg+json')).toBe(true);
    // A raw file of a Git host is served as plain text.
    expect(isJsonType('text/plain; charset=utf-8')).toBe(true);
    expect(isJsonType('text/html')).toBe(false);
    expect(isJsonType(undefined)).toBe(false);
  });
});

describe('download', () => {
  /** A ZIP listed in an index on this machine: only then is this machine asked for it. */
  const listed = (server: HttpFixture) => ({ ...OPTIONS, index: `${server.url}/index.json` });
  async function folder() {
    const dir = await mkdtemp(join(tmpdir(), 'mooncg-download-'));
    dirs.push(dir);
    return dir;
  }

  it('writes the file and says its SHA-256', async () => {
    const body = Buffer.from('an archive');
    const server = await serve({ '/a.zip': bytes(body) });
    const file = join(await folder(), 'a.zip');
    const { sha256 } = await download(`${server.url}/a.zip`, file, listed(server));
    expect(sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(await readFile(file)).toEqual(body);
  });

  it('refuses an archive larger than allowed and leaves no file behind', async () => {
    const server = await serve({ '/big.zip': bytes(Buffer.alloc(5000)) });
    const file = join(await folder(), 'big.zip');
    await expect(download(`${server.url}/big.zip`, file, listed(server))).rejects.toThrow(
      /larger than 1024/,
    );
    expect(existsSync(file)).toBe(false);
  });

  it('rejects, and does not crash the server, when the file cannot be written', async () => {
    // The answer is slow to come: the file fails while the network is still being waited for.
    const server = await serve({
      '/a.zip': (_request, response) => {
        setTimeout(() => bytes(Buffer.from('late'))(_request, response), 100);
      },
    });
    const dir = await folder();
    await writeFile(join(dir, 'a-file'), 'x');
    const file = join(dir, 'a-file', 'a.zip');
    await expect(download(`${server.url}/a.zip`, file, listed(server))).rejects.toThrow();
    // Give an unhandled error event the time to surface: vitest fails the run if one does.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it('leaves no file behind when the answer breaks off', async () => {
    const server = await serve({
      '/cut.zip': (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/zip', 'content-length': '100' });
        response.write('only a part');
        setTimeout(() => response.destroy(), 20);
      },
    });
    const file = join(await folder(), 'cut.zip');
    await expect(download(`${server.url}/cut.zip`, file, listed(server))).rejects.toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it('never removes a file that was there before', async () => {
    const server = await serve({ '/a.zip': bytes(Buffer.from('new')) });
    const file = join(await folder(), 'a.zip');
    await writeFile(file, 'kept');
    await expect(download(`${server.url}/a.zip`, file, listed(server))).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('kept');
  });

  it('asks this machine only for what an index on this machine lists', async () => {
    const server = await serve({ '/a.zip': bytes(Buffer.from('x')) });
    const file = join(await folder(), 'a.zip');
    await expect(download(`${server.url}/a.zip`, file, OPTIONS)).rejects.toThrow(/https|machine/);
    await expect(
      download(`${server.url}/a.zip`, file, { ...OPTIONS, index: 'https://example.org/i.json' }),
    ).rejects.toThrow(/https|machine/);
    expect(server.requests).toHaveLength(0);
  });

  it('sends the credentials of the index to its origin, also for an absolute address', async () => {
    const other = await serve({ '/a.zip': bytes(Buffer.from('x')) });
    const server = await serve({ '/a.zip': bytes(Buffer.from('x')) });
    const host = server.url.replace('http://', '');
    const index = `http://reader:s3cret@${host}/index.json`;
    await download(`${server.url}/a.zip`, join(await folder(), 'a.zip'), { ...OPTIONS, index });
    expect(server.requests.at(-1)?.headers.authorization).toBe(
      `Basic ${Buffer.from('reader:s3cret').toString('base64')}`,
    );
    await download(`${other.url}/a.zip`, join(await folder(), 'a.zip'), { ...OPTIONS, index });
    expect(other.requests.at(-1)?.headers.authorization).toBeUndefined();
  });
});

describe('where the server may connect to', () => {
  it.each([
    'https://10.0.0.1/a.zip',
    'https://172.16.5.4/a.zip',
    'https://192.168.1.1/a.zip',
    'https://169.254.169.254/latest/meta-data/',
    'https://100.64.0.1/a.zip',
    'https://0.0.0.0/a.zip',
    'https://224.0.0.1/a.zip',
    'https://255.255.255.255/a.zip',
    'https://[fe80::1]/a.zip',
    'https://[fc00::1]/a.zip',
    'https://[fd12:3456::1]/a.zip',
    'https://[::]/a.zip',
    'https://[ff02::1]/a.zip',
    'https://[::ffff:a00:1]/a.zip',
    'https://[::ffff:7f00:1]/a.zip',
    'https://127.0.0.1/a.zip',
    'https://[::1]/a.zip',
  ])('refuses %s before it connects', (url) => {
    expect(addressProblem(url, { loopback: false })).toBeDefined();
  });

  it('takes this machine only where it is allowed, and public addresses', () => {
    expect(addressProblem('http://127.0.0.1:9/a.zip', { loopback: true })).toBeUndefined();
    expect(addressProblem('https://[::1]/a.zip', { loopback: true })).toBeUndefined();
    expect(addressProblem('https://10.0.0.1/a.zip', { loopback: true })).toBeDefined();
    expect(addressProblem('https://93.184.215.14/a.zip', { loopback: false })).toBeUndefined();
    expect(
      addressProblem('https://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/', { loopback: false }),
    ).toBeUndefined();
    expect(addressProblem('https://example.org/a.zip', { loopback: false })).toBeUndefined();
  });

  it('refuses a name that resolves to an internal address, at the moment it connects', async () => {
    const file = join(tmpdir(), `mooncg-never-${process.pid}.zip`);
    const resolve = async () => [{ address: '10.1.2.3', family: 4 }];
    await expect(
      download('https://internal.example/a.zip', file, { ...OPTIONS, resolve }),
    ).rejects.toThrow(/10\.1\.2\.3/);
    // Pointed at this machine after it was checked (DNS rebinding): refused all the same.
    const here = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(
      getJson('https://rebind.example/index.json', { ...OPTIONS, resolve: here }),
    ).rejects.toThrow(/this machine/);
    expect(existsSync(file)).toBe(false);
  });

  it('checks every redirect like the first address, also where it points to', async () => {
    const server = await serve({ '/index.json': json({ index: 1 }) });
    server.routes.set('/private', redirect('https://10.0.0.1/index.json'));
    await expect(getJson(`${server.url}/private`, OPTIONS)).rejects.toThrow(/10\.0\.0\.1/);
    server.routes.set('/named', redirect('https://internal.example/index.json'));
    const resolve = async () => [{ address: '192.168.0.10', family: 4 }];
    await expect(getJson(`${server.url}/named`, { ...OPTIONS, resolve })).rejects.toThrow(
      /192\.168\.0\.10/,
    );
    server.routes.set('/slash', redirect('http://169.254.169.254\\@127.0.0.1/'));
    await expect(getJson(`${server.url}/slash`, OPTIONS)).rejects.toThrow(/redirect/);
  });

  it('says clearly when the credentials of an address are no valid percent-encoding', async () => {
    const error = await getJson('https://user:%zz@example.org/index.json', OPTIONS).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'invalid', message: expect.stringMatching(/credentials/) });
  });
});
