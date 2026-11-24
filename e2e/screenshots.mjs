// Takes a picture of every dashboard page, for looking at a change of its layout or styles.
// Not part of `pnpm test:e2e`: run `pnpm screenshots`, which builds first. It starts its own
// server on a free port with a temporary data directory, like the browser tests do.
//
//   node e2e/screenshots.mjs [output directory]
//
// The pictures are taken twice: with the `examples` bundles as they are, and (files ending
// in `-states`) with two more bundles beside them, one that failed and one that is disabled,
// so that the states a healthy example never shows are in the pictures too.
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(process.argv[2] ?? join(repo, 'screenshots'));
const PASSWORD = 'correct horse';
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 800, height: 900 };
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PAGES = [
  ['workspace', '/w/Show'],
  ['bundles', '/bundles'],
  ['graphics', '/graphics'],
  ['assets', '/assets'],
  ['users', '/admin/users'],
  ['roles', '/admin/roles'],
  ['tokens', '/admin/tokens'],
  ['settings', '/settings'],
  ['logs', '/logs'],
];

const temporary = [];
async function temporaryDir(name) {
  const dir = await mkdtemp(join(tmpdir(), `mooncg-shots-${name}-`));
  temporary.push(dir);
  return dir;
}

/** Starts the built server and resolves once it says where it listens. */
async function startServer(bundlesDir) {
  const dataDir = await temporaryDir('data');
  const child = spawn(
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
  const started = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`The server did not start:\n${output}`)), 20_000);
    const read = (chunk) => {
      output += chunk.toString();
      const listening = /listening on (http:\/\/\S+)/.exec(output);
      const setup = /administrator at (\S+)/.exec(output);
      if (!listening || !setup || !/Bundle "scoreboard" is running/.test(output)) return;
      clearTimeout(timer);
      done({ base: listening[1], setupUrl: setup[1] });
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', (code) => fail(new Error(`The server exited with ${code}:\n${output}`)));
  });
  const stop = async () => {
    if (child.exitCode !== null) return;
    const gone = new Promise((done) => child.once('exit', done));
    child.kill();
    await gone;
  };
  console.log(`server pid ${child.pid}`);
  return { ...started, stop };
}

/** The examples, with a bundle that cannot start and one to disable beside them. */
async function bundlesWithStates() {
  const dir = await temporaryDir('bundles');
  await cp(join(repo, 'examples'), dir, { recursive: true });
  const manifest = (name, extra) =>
    JSON.stringify({ manifest: 1, kind: 'bundle', name, version: '0.2.0', ...extra });
  await mkdir(join(dir, 'countdown'));
  await writeFile(
    join(dir, 'countdown', 'mooncg.json'),
    manifest('countdown', { title: 'Countdown', dependencies: { 'team-data': '^1.0.0' } }),
  );
  await mkdir(join(dir, 'sponsor-loop', 'dashboard'), { recursive: true });
  await writeFile(
    join(dir, 'sponsor-loop', 'mooncg.json'),
    manifest('sponsor-loop', {
      title: 'Sponsor loop',
      panels: [
        {
          id: 'playlist',
          title: 'Playlist',
          file: 'dashboard/playlist.html',
          width: 4,
          workspace: 'Show',
        },
      ],
    }),
  );
  await writeFile(
    join(dir, 'sponsor-loop', 'dashboard', 'playlist.html'),
    '<!doctype html><title>Playlist</title><p>Sponsor clips, in order.</p>',
  );
  return dir;
}

async function shoot(browser, bundlesDir, suffix, prepare) {
  const server = await startServer(bundlesDir);
  const problems = [];
  try {
    const { base, setupUrl } = server;
    const context = await browser.newContext({ viewport: WIDE });
    const page = await context.newPage();
    page.on('pageerror', (error) => problems.push(`${page.url()}: ${error.message}`));
    /** Refusals a step provokes on purpose; each is taken off the list of problems once. */
    const refused = [];
    page.on('console', (message) => {
      // A failed request is judged by its response below, which names the URL.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
        problems.push(`${page.url()}: ${message.text()}`);
      }
    });
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 400 && path !== '/favicon.ico') {
        problems.push(`${response.status()} ${path}`);
      }
    });

    // The pages before the dashboard: setup, sign-in, and sign-in after a wrong password.
    const before = async (name) => {
      for (const viewport of [WIDE, NARROW]) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(200);
        const file = join(out, `${name}${suffix}-${viewport.width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(file);
      }
      await page.setViewportSize(WIDE);
    };
    await page.goto(setupUrl);
    await page.locator('.brand img').waitFor();
    await page.waitForLoadState('networkidle');
    await before('setup');
    const code = new URL(setupUrl).searchParams.get('code');
    await page.request.post(`${base}/api/v1/setup`, {
      data: { code, username: 'admin', password: PASSWORD },
    });
    await page.goto(`${base}/login`);
    await page.waitForLoadState('networkidle');
    await before('login');
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'not the password');
    await page.click('button[type="submit"]');
    await page.locator('#notice:not(:empty)').waitFor();
    await before('login-error');
    // That refusal was asked for.
    refused.push('401 /api/v1/auth/login');
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${base}/`);

    // Something to see on every page: a viewer, a token, a logo, a score, a graphic on air.
    await page.request.post(`${base}/api/v1/users`, {
      data: { name: 'vera', password: PASSWORD, roles: ['viewer'] },
    });
    await page.request.post(`${base}/api/v1/tokens`, {
      data: { name: 'OBS', grants: ['bundle:scoreboard:view'] },
    });
    await page.request.put(`${base}/api/v1/bundles/scoreboard/assets/logos/home.png`, {
      data: PIXEL,
      headers: { 'content-type': 'application/octet-stream', 'x-mooncg-csrf': '1' },
    });
    const onAir = await context.newPage();
    await onAir.goto(`${base}/b/scoreboard/graphics/overlay.html`);
    await onAir.locator('#home').waitFor();
    await prepare?.(page, base);

    const take = async (name, path, viewport) => {
      await page.setViewportSize(viewport);
      await page.goto(`${base}${path}`);
      await page.locator('.page-head h1').waitFor();
      // The lists, the frames of the panels and the live counts have arrived by then.
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      const file = join(out, `${name}${suffix}-${viewport.width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
    };
    for (const [name, path] of PAGES) await take(name, path, WIDE);
    for (const [name, path] of PAGES.slice(0, 3)) await take(name, path, NARROW);

    // The dialog of the scoreboard, over the workspace.
    await page.setViewportSize(WIDE);
    await page.goto(`${base}/w/Show`);
    await page.frameLocator('iframe[title="Score"]').locator('#reset').click();
    await page.locator('[role="dialog"]').waitFor();
    await page.waitForTimeout(500);
    const dialog = join(out, `dialog${suffix}-${WIDE.width}.png`);
    await page.screenshot({ path: dialog });
    console.log(dialog);
    await page.keyboard.press('Escape');
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });

    // The focus ring, where the keyboard is: an entry of the navigation, a tool of a panel,
    // a choice of a filter.
    const focused = async (name, path, locator) => {
      await page.goto(`${base}${path}`);
      await page.locator('.page-head h1').waitFor();
      await page.waitForLoadState('networkidle');
      await page.locator(locator).first().focus();
      // A click elsewhere would take the focus away; a key makes it count as keyboard focus.
      await page.keyboard.press('Shift');
      await page.waitForTimeout(300);
      const file = join(out, `focus-${name}${suffix}-${WIDE.width}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: WIDE.width, height: 420 } });
      console.log(file);
    };
    await focused('nav', '/bundles', 'nav[aria-label="Main"] a[href="/graphics"]');
    await focused('tools', '/w/Show', '[data-panel] [data-action="wider"]');
    await focused('filter', '/bundles', '[role="radiogroup"] [role="radio"]');
    await context.close();
    for (const known of refused) {
      const at = problems.indexOf(known);
      if (at >= 0) problems.splice(at, 1);
    }
  } finally {
    await server.stop();
  }
  return problems;
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const problems = [];
try {
  problems.push(...(await shoot(browser, join(repo, 'examples'), '')));
  problems.push(
    ...(await shoot(browser, await bundlesWithStates(), '-states', async (page, base) => {
      // A layout that holds the panel of the bundle that is then disabled.
      await page.goto(`${base}/w/Show`);
      await page.locator('[data-panel="sponsor-loop:playlist"] [data-action="taller"]').click();
      await page.waitForLoadState('networkidle');
      await page.request.post(`${base}/api/v1/bundles/sponsor-loop/disable`, { data: {} });
    })),
  );
} finally {
  await browser.close();
  for (const dir of temporary) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
if (problems.length > 0) {
  console.error(`Problems on the pages:\n${problems.join('\n')}`);
  process.exitCode = 1;
}
