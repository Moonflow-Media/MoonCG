import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  bytes,
  type HttpFixture,
  json,
  startHttpFixture,
} from '../packages/server/test/http-fixture.js';
import { makeZip } from '../packages/server/test/zip-writer.js';

/**
 * The catalog for real: a server of its own with no bundle, the example registry index served
 * by a local server, the scoreboard installed from it in the dashboard, and the update hint
 * that appears once the index lists a newer version.
 */

const repo = fileURLToPath(new URL('..', import.meta.url));
const PASSWORD = 'correct horse';

let server: ChildProcess;
let index: HttpFixture;
let dataDir: string;
let bundlesDir: string;
let base: string;
let setupUrl: string;

/** The scoreboard of the examples as an archive, with its manifest at `version`. */
async function scoreboardZip(version: string): Promise<Buffer> {
  const root = join(repo, 'examples/scoreboard');
  const walk = async (dir: string): Promise<string[]> =>
    (
      await Promise.all(
        (
          await readdir(dir, { withFileTypes: true })
        ).map((entry) =>
          entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
        ),
      )
    ).flat();
  const items = [];
  for (const file of await walk(root)) {
    const name = relative(root, file).split('\\').join('/');
    let data = await readFile(file);
    if (name === 'mooncg.json') {
      data = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString('utf8')), version }));
    }
    items.push({ name, data });
  }
  return makeZip(items);
}

test.beforeAll(async () => {
  const example = JSON.parse(await readFile(join(repo, 'e2e/registry/index.json'), 'utf8'));
  index = await startHttpFixture({
    '/index.json': json(example),
    '/scoreboard-0.1.0.zip': bytes(await readFile(join(repo, 'e2e/registry/scoreboard-0.1.0.zip'))),
  });
  dataDir = await mkdtemp(join(tmpdir(), 'mooncg-e2e-registry-'));
  bundlesDir = await mkdtemp(join(tmpdir(), 'mooncg-e2e-registry-bundles-'));
  server = spawn(
    process.execPath,
    [
      join(repo, 'packages/server/dist/main.js'),
      '--port',
      '0',
      '--bundles-dir',
      bundlesDir,
      '--data-dir',
      dataDir,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The server did not start:\n${output}`)),
      20_000,
    );
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const listening = /listening on (http:\/\/\S+)/.exec(output);
      const setup = /administrator at (\S+)/.exec(output);
      if (!listening || !setup) return;
      base = listening[1] as string;
      setupUrl = setup[1] as string;
      clearTimeout(timer);
      resolve();
    };
    server.stdout?.on('data', read);
    server.stderr?.on('data', read);
    server.once('exit', (code) => reject(new Error(`The server exited with ${code}:\n${output}`)));
  });
});

test.afterAll(async () => {
  if (server.exitCode === null) {
    const gone = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await gone;
  }
  await index.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(bundlesDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('add the example index, install from the catalog, see an update hint', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  // Nothing of another site is loaded by the dashboard: no icon, no picture.
  page.on('request', (request) => {
    if (!request.url().startsWith(base)) problems.push(`requested ${request.url()}`);
  });

  const code = new URL(setupUrl).searchParams.get('code');
  const created = await page.request.post(`${base}/api/v1/setup`, {
    data: { code, username: 'ada', password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/login`);
  await page.fill('input[name="username"]', 'ada');
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${base}/`);

  // The catalog is empty until an index is added.
  await page.goto(`${base}/bundles/catalog`);
  await expect(page.getByText('No index is set up')).toBeVisible();
  await page.fill('input[name="index-url"]', `${index.url}/index.json`);
  await page.getByRole('button', { name: 'Add index' }).click();
  const entry = page.locator('[data-entry="bundle:scoreboard"]');
  await expect(entry).toContainText('The example bundle of MoonCG');
  await expect(page.locator('[data-index]')).toContainText('1 entry');

  // Installing goes through staging: the summary says where it came from.
  await entry.getByRole('button', { name: 'Install' }).click();
  await expect(page.getByText('waits on the Bundles page')).toBeVisible();
  await page.getByRole('link', { name: 'Go to Bundles' }).click();
  const staged = page.locator('.card.staged');
  await expect(staged).toContainText(`${index.url}/index.json`);
  await expect(staged).toContainText('not checked by MoonCG');
  await staged.getByRole('button', { name: 'Install' }).click();
  const row = page.locator('[data-bundle="scoreboard"]');
  await expect(row.locator('.state')).toHaveText('running', { timeout: 20_000 });
  await expect(row.locator('[data-badge="update"]')).toHaveCount(0);

  // A newer version appears in the index.
  const newer = await scoreboardZip('0.2.0');
  const example = JSON.parse(await readFile(join(repo, 'e2e/registry/index.json'), 'utf8'));
  const [listed] = example.entries;
  listed.versions.push({
    version: '0.2.0',
    engine: { mooncg: '>=0.10.0' },
    source: {
      type: 'zip',
      url: 'scoreboard-0.2.0.zip',
      sha256: createHash('sha256').update(newer).digest('hex'),
    },
  });
  index.routes.set('/index.json', json(example));
  index.routes.set('/scoreboard-0.2.0.zip', bytes(newer));

  await page.goto(`${base}/bundles/catalog`);
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(entry.locator('[data-badge="update"]')).toHaveText('Update available: 0.2.0');
  await page.goto(`${base}/bundles`);
  await expect(row.locator('[data-badge="update"]')).toHaveText('Update available: 0.2.0');

  // One click fetches the update; it is put in place like any other.
  await row.getByRole('button', { name: 'Update to 0.2.0' }).click();
  await expect(staged).toContainText('Update of 0.1.0');
  await staged.getByRole('button', { name: 'Update' }).click();
  await expect(row).toContainText('scoreboard 0.2.0', { timeout: 20_000 });
  await expect(row.locator('[data-badge="update"]')).toHaveCount(0);
  expect(problems).toEqual([]);
});
