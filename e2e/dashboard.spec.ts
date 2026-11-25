import { type ChildProcess, spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { startMockIdp } from '../packages/module-auth-oidc/test/mock-idp.js';
import { zipOf } from '../packages/server/test/zip-writer.js';

/**
 * The tests that run everything for real: the built server, the built dashboard and the
 * example bundle in Chromium. They share one server, started once, and each of them brings
 * about what it needs itself, so one that fails does not take the others with it.
 */

const repo = fileURLToPath(new URL('..', import.meta.url));
const PASSWORD = 'correct horse';
const START_TIMEOUT_MS = 20_000;
/** The value of the example's secret setting. No page may ever be sent it back. */
const SECRET = 'e2e-results-key-7f3a';
/** A PNG of one pixel. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const OVERLAY = '/b/scoreboard/graphics/overlay.html';
const UPLOAD = { 'content-type': 'application/octet-stream', 'x-mooncg-csrf': '1' };

let server: ChildProcess;
let dataDir: string;
/** A copy of the examples: bundles are installed into it, never into the repository. */
let bundlesDir: string;
let base: string;
let setupUrl: string;
const contexts: BrowserContext[] = [];

/** Starts the built server on a free port and waits until it has said where it listens. */
test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mooncg-e2e-'));
  bundlesDir = await mkdtemp(join(tmpdir(), 'mooncg-e2e-bundles-'));
  await cp(join(repo, 'examples'), bundlesDir, { recursive: true });
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
      // Live reload without dev mode: what a studio runs while a bundle is being finished.
      '--watch',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The server did not start:\n${output}`)),
      START_TIMEOUT_MS,
    );
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const listening = /listening on (http:\/\/\S+)/.exec(output);
      const setup = /administrator at (\S+)/.exec(output);
      if (!listening || !setup || !/Bundle "scoreboard" is running/.test(output)) return;
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
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(bundlesDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// Every page of a test is closed with it, so that no graphic of one test is still on air,
// holding the one place of the overlay, when the next begins.
test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

/** A page in a browser context of its own: no cookie, no storage of any other. */
async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  return context.newPage();
}

async function signIn(page: Page, username: string) {
  await page.goto(`${base}/login`);
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${base}/`);
}

/** Makes sure the administrator exists, however far the test that sets up through the page got. */
async function ensureAdmin(browser: Browser) {
  const page = await freshPage(browser);
  const code = new URL(setupUrl).searchParams.get('code');
  const answer = await page.request.post(`${base}/api/v1/setup`, {
    data: { code, username: 'ada', password: PASSWORD },
  });
  // 404 once a user exists: then there is nothing left to set up.
  expect([201, 404]).toContain(answer.status());
  await page.context().close();
}

/** A page signed in as the administrator, with the viewer `vera` in existence. */
async function asAdmin(browser: Browser): Promise<Page> {
  await ensureAdmin(browser);
  const page = await freshPage(browser);
  await signIn(page, 'ada');
  const created = await page.request.post(`${base}/api/v1/users`, {
    data: { name: 'vera', password: PASSWORD, roles: ['viewer'] },
  });
  expect([201, 409]).toContain(created.status());
  return page;
}

async function asViewer(browser: Browser): Promise<Page> {
  const page = await freshPage(browser);
  await signIn(page, 'vera');
  return page;
}

const nav = (page: Page, name: string) => page.getByRole('navigation').getByRole('link', { name });
const control = (page: Page) => page.frameLocator('iframe[title="Score"]');

/**
 * Watches pages for what must not happen: an error on the page, a request that fails, and
 * the secret in anything the server sends.
 */
function watcher() {
  const problems: string[] = [];
  /** Everything the server sent to a watched page: headers, bodies and socket frames. */
  const received: Promise<string>[] = [];
  return {
    problems,
    received,
    /** Takes a refusal the test provoked on purpose off the list, and insists it was there. */
    expected(problem: string) {
      expect(problems).toContain(problem);
      problems.splice(problems.indexOf(problem), 1);
    },
    watch(page: Page, options: { readonly refusals?: boolean } = {}) {
      page.on('pageerror', (error) => problems.push(`${page.url()}: ${error.message}`));
      page.on('console', (message) => {
        // A failed request is judged by its response below, which names the URL.
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
          problems.push(`${page.url()}: ${message.text()}`);
        }
      });
      page.on('response', (response) => {
        const path = new URL(response.url()).pathname;
        // A page whose refusals are the point of the test is watched for the secret only.
        if (options.refusals !== false && response.status() >= 400 && path !== '/favicon.ico') {
          problems.push(`${response.status()} ${path}`);
        }
        const headers = Object.entries(response.headers()).map((pair) => pair.join(': '));
        received.push(Promise.resolve(headers.join('\n')));
        // A redirect or an aborted answer has no body to read.
        received.push(response.text().catch(() => ''));
      });
      page.on('websocket', (socket) => {
        socket.on('framereceived', (frame) =>
          received.push(Promise.resolve(String(frame.payload))),
        );
      });
      return page;
    },
  };
}

test('setup, sign in, operate the panel, see the graphic, keep the layout', async ({ browser }) => {
  const { problems, expected, watch } = watcher();
  /** The page is drawn as the dashboard is: a card on the dark page, with the mark. */
  const drawn = async (page: Page) => {
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(20, 22, 26)');
    await expect(page.locator('.card')).toHaveCSS('background-color', 'rgb(27, 30, 36)');
    await expect(page.locator('button[type="submit"]')).toHaveCSS(
      'background-color',
      'rgb(138, 180, 248)',
    );
    const mark = page.locator('.brand img');
    await expect
      .poll(() => mark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth))
      .toBeGreaterThan(0);
  };

  // --- Setup: the URL the server printed creates the first administrator.
  const admin = watch(await freshPage(browser));
  await admin.goto(setupUrl);
  await expect(admin.locator('input[name="code"]')).not.toHaveValue('');
  await expect(admin.locator('h1')).toHaveText('MoonCG setup');
  await drawn(admin);
  await admin.fill('input[name="username"]', 'ada');
  await admin.fill('input[name="password"]', PASSWORD);
  await admin.click('button[type="submit"]');
  await admin.waitForURL(`${base}/login`);

  // --- The sign-in page says why it refused, and stays.
  await drawn(admin);
  const notice = admin.locator('p#notice.errors[role="alert"]');
  await expect(notice).toHaveText('');
  await admin.fill('input[name="username"]', 'ada');
  await admin.fill('input[name="password"]', 'not the password');
  await admin.click('button[type="submit"]');
  await expect(notice).not.toHaveText('');
  await expect(notice).toHaveCSS('color', 'rgb(255, 157, 157)');
  expected('401 /api/v1/auth/login');
  expect(new URL(admin.url()).pathname).toBe('/login');

  // --- Sign in: the dashboard shows who is signed in and the workspace of the example.
  await signIn(admin, 'ada');
  await expect(admin.locator('[data-user-name]')).toHaveText('ada');
  await expect(nav(admin, 'Show')).toBeVisible();
  await expect(nav(admin, 'Users')).toBeVisible();

  // --- The panel of the scoreboard is framed in its workspace and works.
  const panel = admin.locator('[data-panel="scoreboard:control"]');
  await expect(panel).toBeVisible();
  await expect(control(admin).locator('#score')).toHaveText('0:0');
  await control(admin).locator('#home').click();
  await control(admin).locator('#home').click();
  await control(admin).locator('#away').click();
  await expect(control(admin).locator('#score')).toHaveText('2:1');

  // --- The graphic, in a tab of its own, shows the same score and follows it.
  const graphic = watch(await admin.context().newPage());
  await graphic.goto(`${base}${OVERLAY}`);
  await expect(graphic.locator('#home')).toHaveText('2');
  await expect(graphic.locator('#away')).toHaveText('1');
  await control(admin).locator('#away').click();
  await expect(graphic.locator('#away')).toHaveText('2');

  // --- The layout is changed, and is there again in a browser that has never been here.
  await expect(panel).toHaveClass(/\bw-3\b/);
  await panel.locator('[data-action="wider"]').click();
  await panel.locator('[data-action="taller"]').click();
  await expect(panel).toHaveClass(/\bw-4\b/);
  await expect(panel).toHaveClass(/\bh-3\b/);
  const elsewhere = watch(await freshPage(browser));
  await signIn(elsewhere, 'ada');
  const samePanel = elsewhere.locator('[data-panel="scoreboard:control"]');
  await expect(samePanel).toHaveClass(/\bw-4\b/);
  await expect(samePanel).toHaveClass(/\bh-3\b/);

  // --- The bundle page lists the bundle with its state and, for an admin, its buttons.
  await nav(elsewhere, 'Bundles').click();
  const row = elsewhere.locator('[data-bundle="scoreboard"]');
  await expect(row).toContainText('running');
  await expect(row.getByRole('button', { name: 'Reload' })).toBeVisible();

  // --- The log page shows what the server logged, without the setup code.
  await nav(elsewhere, 'Logs').click();
  await expect(
    elsewhere.locator('[data-log]').filter({ hasText: 'Score is 0:0' }).first(),
  ).toBeVisible();
  const setupCode = new URL(setupUrl).searchParams.get('code') as string;
  await expect(elsewhere.locator('.log')).toContainText('setup?code=***');
  await expect(elsewhere.locator('.log')).not.toContainText(setupCode);

  expect(problems).toEqual([]);
});

test('a graphic that takes one instance: refused, replaced, taken over, reloaded, disconnected', async ({
  browser,
}) => {
  const { problems, watch } = watcher();
  const admin = watch(await asAdmin(browser));
  await nav(admin, 'Graphics').click();
  const listed = admin.locator('[data-graphic="scoreboard:overlay"]');
  await expect(listed).toContainText('takes one instance');
  await expect(listed).toContainText('Not open anywhere');

  // --- The first page is on air, and the graphics page says whose it is.
  const first = watch(await admin.context().newPage());
  await first.goto(`${base}${OVERLAY}`);
  await expect(first.locator('#home')).toHaveText(/^\d+$/);
  const score = (await first.locator('#home').textContent()) ?? '';
  await expect(listed.locator('[data-instance]')).toHaveCount(1);
  await expect(listed.locator('[data-instance]')).toContainText('Open by ada (user)');

  // --- Someone else who opens it is refused, and shows that instead of the score.
  const viewer = watch(await asViewer(browser));
  await viewer.goto(`${base}${OVERLAY}`);
  await expect(viewer.locator('#mooncg-duplicate')).toContainText('already open');
  await expect(listed.locator('[data-instance]')).toHaveCount(1);

  // --- The same account opening it again takes its own place: the page before is told
  // so and stays away; the new one is on air.
  const again = watch(await admin.context().newPage());
  await again.goto(`${base}${OVERLAY}`);
  await expect(first.locator('#mooncg-ended')).toContainText('opened again somewhere else');
  await expect(again.locator('#home')).toHaveText(score);
  await expect(again.locator('#mooncg-duplicate, #mooncg-ended')).toHaveCount(0);
  await expect(listed.locator('[data-instance]')).toHaveCount(1);

  // --- Once that page is closed, the one that waited gets the place and shows the score.
  await again.close();
  await expect(viewer.locator('#mooncg-duplicate')).toHaveCount(0);
  await expect(viewer.locator('#home')).toHaveText(score);
  await expect(listed.locator('[data-instance]')).toContainText('Open by vera (user)');
  // The page that was replaced has not come back by itself meanwhile.
  await expect(first.locator('#mooncg-ended')).toBeVisible();

  // --- The graphics page reloads that one page.
  await Promise.all([
    viewer.waitForEvent('framenavigated'),
    listed.locator('[data-instance]').getByRole('button', { name: 'Reload' }).click(),
  ]);
  await expect(viewer.locator('#home')).toHaveText(score);
  await expect(viewer.locator('#mooncg-duplicate')).toHaveCount(0);

  // --- And disconnects it, which frees the place: the page says so and stays away.
  await listed.locator('[data-instance]').getByRole('button', { name: 'Disconnect' }).click();
  await expect(viewer.locator('#mooncg-ended')).toContainText('disconnected by an operator');
  await expect(listed).toContainText('Not open anywhere');

  expect(problems).toEqual([]);
});

test('a dialog: opened by the panel, answered, and gone with the panel', async ({ browser }) => {
  const { problems, watch } = watcher();
  const admin = watch(await asAdmin(browser));
  const score = control(admin).locator('#score');
  // The score of the tests before is kept, so that it is not nil does not say that the
  // click has arrived: the score it had is waited to change.
  await expect(score).toHaveText(/^\d+:\d+$/);
  const untouched = (await score.textContent()) ?? '';
  await control(admin).locator('#home').click();
  await expect(score).not.toHaveText(untouched);
  await expect(score).toHaveText(/^[1-9]\d*:\d+$/);
  const before = (await score.textContent()) ?? '';

  // --- The panel asks before it resets, in a dialog the dashboard draws over everything.
  const dialog = admin.locator('[role="dialog"]');
  const dialogPage = admin.frameLocator('[role="dialog"] iframe');
  await control(admin).locator('#reset').click();
  await expect(dialog).toHaveAttribute('aria-label', 'Reset the score?');
  await expect(dialog).toHaveAttribute('data-dialog', 'scoreboard:confirm-reset');
  // The dialog page was handed the data the panel passed.
  await expect(dialogPage.locator('#score')).toHaveText(before);
  await dialogPage.locator('#cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(score).toHaveText(before);

  // --- The panel gets back what the dialog page closed with, and acts on it.
  await control(admin).locator('#reset').click();
  await dialogPage.locator('#confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(score).toHaveText('0:0');

  // --- A dialog does not outlive the page that asked for it.
  await control(admin).locator('#reset').click();
  await expect(dialog).toHaveCount(1);
  await control(admin)
    .locator('body')
    .evaluate(() => location.reload());
  await expect(dialog).toHaveCount(0);
  await expect(score).toHaveText('0:0');

  expect(problems).toEqual([]);
});

test('settings: saved, seen by the extension, refused when wrong, and the secret never sent back', async ({
  browser,
}) => {
  const { problems, received, expected, watch } = watcher();
  const admin = watch(await asAdmin(browser));
  const graphic = watch(await admin.context().newPage());
  await graphic.goto(`${base}${OVERLAY}`);
  await expect(graphic.locator('#title')).toHaveText('Scoreboard');

  // --- The form drawn from the bundle's schema.
  await nav(admin, 'Settings').click();
  const settings = admin.locator('[data-config="scoreboard"]');
  await expect(settings.locator('[data-field="/title"]')).toHaveValue('Scoreboard');
  await expect(settings.locator('[data-field="/maxScore"]')).toHaveValue('99');
  const key = settings.locator('[data-field="/resultsApiKey"]');
  await expect(key).toHaveAttribute('type', 'password');
  await expect(key).toHaveAttribute('placeholder', 'Not set');

  // --- Saving restarts the extension, and the page says that it did.
  await settings.locator('[data-field="/title"]').fill('Cup final');
  await settings.locator('[data-field="/maxScore"]').fill('3');
  await key.fill(SECRET);
  await settings.getByRole('button', { name: 'Save and restart' }).click();
  await expect(settings.locator('[role="status"]')).toContainText(
    'The extension was restarted with the new settings',
  );
  // The secret is stored and the page is told that, and nothing more.
  await expect(key).toHaveValue('');
  await expect(key).toHaveAttribute('placeholder', /A value is stored/);
  expect(JSON.parse(await readFile(join(dataDir, 'config', 'scoreboard.json'), 'utf8'))).toEqual({
    title: 'Cup final',
    maxScore: 3,
    resultsApiKey: SECRET,
  });

  // --- The extension saw the new values: it set the title, and clamps at the new maximum.
  // The graphic on air was not interrupted for it.
  await expect(graphic.locator('#title')).toHaveText('Cup final');
  await nav(admin, 'Show').click();
  for (let click = 0; click < 5; click++) await control(admin).locator('#home').click();
  await expect(control(admin).locator('#score')).toHaveText(/^3:/);
  await expect(graphic.locator('#home')).toHaveText('3');
  // It was told the secret, and says so without saying it.
  await nav(admin, 'Logs').click();
  await expect(
    admin.locator('[data-log]').filter({ hasText: 'The results service key is set' }).first(),
  ).toBeVisible();

  // --- What does not fit the schema is refused with the reason, and nothing changes.
  await nav(admin, 'Settings').click();
  await settings.locator('[data-field="/maxScore"]').fill('5000');
  await settings.getByRole('button', { name: 'Save and restart' }).click();
  await expect(settings.locator('[role="alert"]')).toContainText('/maxScore: must be <= 999');
  expected('400 /api/v1/bundles/scoreboard/config');

  // --- A viewer looks around meanwhile: what is sent to that browser is searched as well.
  const viewer = watch(await asViewer(browser), { refusals: false });
  await nav(viewer, 'Bundles').click();
  await expect(viewer.locator('[data-bundle="scoreboard"]')).toContainText('running');
  await nav(viewer, 'Assets').click();
  await nav(viewer, 'Graphics').click();
  await expect(viewer.locator('[data-graphic="scoreboard:overlay"]')).toBeVisible();
  for (const path of ['/api/v1/config', '/api/v1/bundles/scoreboard/config', '/api/v1/logs']) {
    await viewer.goto(`${base}${path}`);
  }
  await viewer.goto(`${base}${OVERLAY}`);
  await expect(viewer.locator('#mooncg-duplicate')).toBeVisible();

  expect(problems).toEqual([]);

  // The secret was sent to the server once and never came back: it is in no answer and no
  // frame any of these pages received, in the dashboard, the panel, the graphic, or the
  // viewer's browser.
  const everything = await Promise.all(received);
  expect(everything.length).toBeGreaterThan(50);
  expect(everything.filter((text) => text.includes(SECRET))).toEqual([]);
});

test('assets: uploaded, shown by the graphic, refused when wrong, never run as a page', async ({
  browser,
}) => {
  const { problems, expected, watch } = watcher();
  const admin = watch(await asAdmin(browser));
  const graphic = watch(await admin.context().newPage());
  await graphic.goto(`${base}${OVERLAY}`);
  await expect(graphic.locator('#home-logo')).toBeHidden();

  // --- A logo uploaded on the assets page shows in the graphic without a reload.
  await nav(admin, 'Assets').click();
  const logos = admin.locator('[data-category="scoreboard:logos"]');
  await expect(logos).toContainText('No files yet');
  const choose = logos.locator('input[type="file"]');
  await choose.setInputFiles({ name: 'home.png', mimeType: 'image/png', buffer: PIXEL });
  await expect(logos.locator('[data-asset="home.png"]')).toBeVisible();
  const logo = graphic.locator('#home-logo');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', /^\/b\/scoreboard\/assets\/logos\/home\.png\?v=/);
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth))
    .toBe(1);

  // --- A file the category does not take is refused, and the page says why.
  await choose.setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await expect(logos).toContainText('notes.txt: The category "logos" takes image/* only');
  expected('415 /api/v1/bundles/scoreboard/assets/logos/notes.txt');

  // --- An uploaded SVG with a script in it is an image that runs nothing. Opened as a page
  // of its own it has finished loading, and the script has neither marked the document nor
  // asked the server for anything: the document is sandboxed, without an origin.
  const evil =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<script>document.documentElement.setAttribute("data-ran", "yes");' +
    'fetch("/api/v1/me?ran-from-upload")</script><rect width="10" height="10"/></svg>';
  await choose.setInputFiles({
    name: 'evil.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(evil),
  });
  await expect(logos.locator('[data-asset="evil.svg"]')).toBeVisible();
  const opened = await admin.context().newPage();
  const asked: string[] = [];
  opened.on('request', (request) => asked.push(request.url()));
  const svg = await opened.goto(`${base}/b/scoreboard/assets/logos/evil.svg`, {
    waitUntil: 'load',
  });
  expect(svg?.status()).toBe(200);
  expect(svg?.headers()['content-security-policy']).toMatch(/^sandbox;/);
  expect(svg?.headers()['x-content-type-options']).toBe('nosniff');
  // The document is there, drawn from the file, and a script in it would have run by now.
  await expect(opened.locator('svg rect')).toHaveCount(1);
  await expect(opened.locator('svg')).not.toHaveAttribute('data-ran', 'yes');
  expect(await opened.evaluate(() => self.origin)).toBe('null');
  expect(asked.filter((url) => url.includes('ran-from-upload'))).toEqual([]);
  await opened.close();

  // --- A part of a file can be asked for, as a player that seeks does.
  const part = await admin.request.get(`${base}/b/scoreboard/assets/logos/home.png`, {
    headers: { range: 'bytes=0-7' },
  });
  expect(part.status()).toBe(206);
  expect((await part.body()).equals(PIXEL.subarray(0, 8))).toBe(true);

  // --- Deleting the logo takes it out of the graphic again.
  admin.once('dialog', (question) => void question.accept());
  await logos.locator('[data-asset="home.png"]').getByRole('button', { name: 'Delete' }).click();
  await expect(logos.locator('[data-asset="home.png"]')).toHaveCount(0);
  await expect(graphic.locator('#home-logo')).toBeHidden();

  expect(problems).toEqual([]);
});

test('the shell: grouped navigation, counts, connection, and every page without a complaint', async ({
  browser,
}) => {
  const { problems, watch } = watcher();
  const admin = watch(await asAdmin(browser));

  // --- The navigation in its groups, each under its label.
  const labels = (page: Page) => page.locator('nav[aria-label="Main"] .nav-label');
  await expect(labels(admin)).toHaveText(['Workspaces', 'Show', 'Admin', 'System']);
  const group = (name: string) => admin.locator(`[data-nav-group="${name}"] a.nav-item`);
  await expect(group('Show')).toHaveText([/^Bundles/, /^Graphics/, /^Assets$/]);
  await expect(group('Admin')).toHaveText(['Users', 'Roles', 'Tokens']);
  await expect(group('System')).toHaveText([/^Settings$/, /^Modules$/, /^Logs/]);
  await expect(admin.locator('a[href="/w/Show"] .count')).toHaveText('1');
  await expect(admin.locator('a[href="/bundles"] .count')).toHaveCount(0);

  // --- The mark is a file of the dashboard, served to whoever is signed in and nobody else.
  const mark = admin.locator('.sidebar-brand img');
  await expect
    .poll(() => mark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth))
    .toBeGreaterThan(0);
  const markPath = (await mark.getAttribute('src')) ?? '';
  expect(markPath).toMatch(/^\/ui\/logo-mark-.+\.svg$/);
  const anonymous = await freshPage(browser);
  expect((await anonymous.request.get(`${base}${markPath}`)).status()).toBe(401);

  // --- The connection is live, and a graphic that goes on air is counted.
  await expect(admin.locator('.conn')).toHaveAttribute('data-status', 'live');
  await expect(admin.locator('.conn')).toContainText('Live');
  await expect(admin.locator('a[href="/graphics"] .count')).toHaveCount(0);
  const graphic = watch(await admin.context().newPage());
  await graphic.goto(`${base}${OVERLAY}`);
  await expect(admin.locator('a[href="/graphics"] .count')).toHaveText('1');
  // The graphics page, entered while the graphic is already open, says whose it is.
  await nav(admin, 'Graphics').click();
  const open = admin.locator('[data-graphic="scoreboard:overlay"] [data-instance]');
  await expect(open).toHaveCount(1);
  await expect(open).toContainText('Open by ada (user)');
  await graphic.close();
  await expect(admin.locator('a[href="/graphics"] .count')).toHaveCount(0);

  // --- Every page, each under its heading. Nothing on any of them is refused by the
  // server or by the page's Content-Security-Policy, which would be an error on the console.
  const pages = [
    ['Show', 'Show'],
    ['Bundles', 'Bundles'],
    ['Graphics', 'Graphics'],
    ['Assets', 'Assets'],
    ['Users', 'Users'],
    ['Roles', 'Roles'],
    ['Tokens', 'API tokens'],
    ['Settings', 'Settings'],
    ['Modules', 'Modules'],
    ['Logs', 'Logs'],
  ] as const;
  for (const [link, heading] of pages) {
    await nav(admin, link).click();
    await expect(admin.locator('.page-head h1')).toContainText(heading);
    await expect(nav(admin, link)).toHaveClass(/router-link-active/);
  }

  // --- A viewer has the groups of what a viewer may open, and no label of another. The
  // page asks for nothing it would be refused, the log among it.
  const viewer = watch(await asViewer(browser));
  await expect(viewer.locator('[data-user-name]')).toHaveText('vera');
  await expect(labels(viewer)).toHaveText(['Show']);
  await expect(viewer.locator('nav[aria-label="Main"]')).not.toContainText(
    /Admin|System|Workspaces/,
  );
  await expect(viewer.locator('[data-nav-group]')).toHaveCount(1);
  await nav(viewer, 'Bundles').click();
  await expect(viewer.locator('[data-bundle="scoreboard"]')).toBeVisible();
  // Longer than the log is asked for anew by those who may read it.
  await viewer.waitForTimeout(2500);

  // --- Narrow, the navigation lies above the page instead of beside it.
  await admin.setViewportSize({ width: 800, height: 900 });
  const sidebar = await admin.locator('.sidebar').boundingBox();
  const content = await admin.locator('.content').boundingBox();
  expect(sidebar?.width).toBe(800);
  expect(content?.y).toBeGreaterThanOrEqual((sidebar?.y ?? 0) + (sidebar?.height ?? 0));
  expect(await admin.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800);

  expect(problems).toEqual([]);
});

test('the bundle filter, the copied URL, the keyboard and reduced motion', async ({ browser }) => {
  const { problems, watch } = watcher();
  const admin = watch(await asAdmin(browser));
  await admin.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  // --- The filter narrows the list, by the mouse and by the arrow keys.
  await nav(admin, 'Bundles').click();
  const filter = admin.getByRole('radiogroup', { name: 'Filter' });
  const choice = (name: RegExp) => filter.getByRole('radio', { name });
  const row = admin.locator('[data-bundle="scoreboard"]');
  await expect(choice(/^All/)).toHaveAttribute('aria-checked', 'true');
  await expect(row).toContainText('1 panel · 1 graphic');
  await choice(/^disabled/).click();
  await expect(row).toHaveCount(0);
  await expect(admin.locator('.empty', { hasText: 'No bundle' })).toHaveText(
    'No bundle is disabled.',
  );
  await expect(choice(/^disabled/)).toBeFocused();
  await admin.keyboard.press('Home');
  await expect(choice(/^All/)).toHaveAttribute('aria-checked', 'true');
  await expect(choice(/^All/)).toBeFocused();
  await admin.keyboard.press('ArrowRight');
  await expect(choice(/^running/)).toHaveAttribute('aria-checked', 'true');
  await expect(choice(/^running/)).toBeFocused();
  await expect(row).toBeVisible();
  await admin.keyboard.press('ArrowRight');
  await expect(choice(/^failed/)).toHaveAttribute('aria-checked', 'true');
  await expect(row).toHaveCount(0);

  // --- A key figure is a button that holds the filter, and lets go of it.
  const running = admin.locator('.stat[data-stat="running"]');
  await running.click();
  await expect(running).toHaveAttribute('aria-pressed', 'true');
  await expect(choice(/^running/)).toHaveAttribute('aria-checked', 'true');
  await expect(row).toBeVisible();
  await running.click();
  await expect(running).toHaveAttribute('aria-pressed', 'false');
  await expect(choice(/^All/)).toHaveAttribute('aria-checked', 'true');

  // --- Copy puts the URL of the graphic on the clipboard and says so.
  await nav(admin, 'Graphics').click();
  const card = admin.locator('[data-graphic="scoreboard:overlay"]');
  await expect(card.locator('iframe, img')).toHaveCount(0);
  await card.getByRole('button', { name: 'Copy' }).click();
  await expect(card.locator('.copy-field button')).toHaveText('Copied');
  expect(await admin.evaluate(() => navigator.clipboard.readText())).toBe(`${base}${OVERLAY}`);
  await expect(card.locator('.copy-field button')).toHaveText('Copy');

  // --- Tab reaches the navigation, and what has the focus shows a ring.
  await admin.locator('.sidebar-brand').click();
  await admin.keyboard.press('Tab');
  const first = admin.locator('nav[aria-label="Main"] a.nav-item').first();
  await expect(first).toBeFocused();
  expect(await first.evaluate((link) => getComputedStyle(link).boxShadow)).not.toBe('none');

  // --- Escape closes a dialog while the keys go to the dialog page, and from the dashboard.
  await nav(admin, 'Show').click();
  const dialog = admin.locator('[role="dialog"]');
  await control(admin).locator('#reset').click();
  await expect(dialog).toHaveCount(1);
  await expect(admin.frameLocator('[role="dialog"] iframe').locator('#cancel')).toBeVisible();
  await admin.frameLocator('[role="dialog"] iframe').locator('body').press('Escape');
  await expect(dialog).toHaveCount(0);
  await control(admin).locator('#reset').click();
  await dialog.getByRole('button', { name: 'Close' }).focus();
  await admin.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // --- The tools of a panel are dimmed until the panel is pointed at or has the focus.
  const tools = admin.locator('[data-panel="scoreboard:control"] .tools');
  await admin.locator('.page-head h1').hover();
  await expect(tools).toHaveCSS('opacity', '0.35');
  await tools.locator('[data-action="left"]').focus();
  await expect(tools).toHaveCSS('opacity', '1');

  // --- Whoever asked for less motion gets none.
  const logout = admin.locator('#logout');
  await expect(logout).toHaveCSS('transition-duration', /0\.12s/);
  await admin.emulateMedia({ reducedMotion: 'reduce' });
  await expect(logout).toHaveCSS('transition-duration', /^0s(, 0s)*$/);

  expect(problems).toEqual([]);
});

test('a viewer gets none of it: no settings, dialog, upload, delete, reload or disconnect', async ({
  browser,
}) => {
  const admin = await asAdmin(browser);
  const put = await admin.request.put(`${base}/api/v1/bundles/scoreboard/assets/logos/away.png`, {
    data: PIXEL,
    headers: UPLOAD,
  });
  expect(put.status()).toBe(201);
  // The administrator has the graphic on air.
  const graphic = await admin.context().newPage();
  await graphic.goto(`${base}${OVERLAY}`);
  await expect(graphic.locator('#away-logo')).toBeVisible();

  // --- The dashboard without the panel and the admin pages.
  const viewer = await asViewer(browser);
  await expect(viewer.locator('[data-user-name]')).toHaveText('vera');
  await expect(nav(viewer, 'Bundles')).toBeVisible();
  for (const name of ['Users', 'Roles', 'Tokens', 'Settings', 'Logs']) {
    await expect(nav(viewer, name)).toHaveCount(0);
  }
  expect((await viewer.request.get(`${base}/api/v1/logs`)).status()).toBe(403);
  await expect(viewer.locator('iframe')).toHaveCount(0);
  await nav(viewer, 'Bundles').click();
  await expect(viewer.locator('[data-bundle="scoreboard"]')).toContainText('running');
  await expect(viewer.locator('[data-bundle="scoreboard"] button')).toHaveCount(0);

  // --- No settings, and no dialog.
  for (const path of ['/api/v1/config', '/api/v1/bundles/scoreboard/config']) {
    expect((await viewer.request.get(`${base}${path}`)).status()).toBe(403);
  }
  const written = await viewer.request.put(`${base}/api/v1/bundles/scoreboard/config`, {
    data: { values: { title: 'Mine now' } },
  });
  expect(written.status()).toBe(403);
  const dialogFile = await viewer.request.get(`${base}/b/scoreboard/dashboard/confirm-reset.html`);
  expect(dialogFile.status()).toBe(403);

  // --- The assets are there to see, not to change.
  await nav(viewer, 'Assets').click();
  const logos = viewer.locator('[data-category="scoreboard:logos"]');
  await expect(logos.locator('[data-asset="away.png"]')).toBeVisible();
  await expect(logos.locator('input[type="file"]')).toHaveCount(0);
  await expect(logos.locator('button')).toHaveCount(0);
  const uploaded = await viewer.request.put(
    `${base}/api/v1/bundles/scoreboard/assets/logos/mine.png`,
    { data: PIXEL, headers: UPLOAD },
  );
  expect(uploaded.status()).toBe(403);
  const deleted = await viewer.request.delete(
    `${base}/api/v1/bundles/scoreboard/assets/logos/away.png`,
    { data: {} },
  );
  expect(deleted.status()).toBe(403);

  // --- That the graphic is open is shown; by whom is not, and nothing can be done to it.
  await nav(viewer, 'Graphics').click();
  const instance = viewer.locator('[data-graphic="scoreboard:overlay"] [data-instance]');
  await expect(instance).toHaveCount(1);
  await expect(instance).not.toContainText('ada');
  await expect(instance.locator('button')).toHaveCount(0);
  const id = await instance.getAttribute('data-instance');
  expect((await viewer.request.get(`${base}/api/v1/bundles/scoreboard/instances`)).status()).toBe(
    403,
  );
  for (const action of ['reload', 'disconnect']) {
    const answer = await viewer.request.post(
      `${base}/api/v1/bundles/scoreboard/instances/${id}/${action}`,
      { data: {} },
    );
    expect(answer.status()).toBe(403);
  }

  // --- The viewer may open the graphic, where it is a second instance, and may read the
  // score from a page of the bundle, but not write it.
  const refused = await viewer.goto(`${base}/b/scoreboard/dashboard/control.html`);
  expect(refused?.status()).toBe(403);
  await viewer.goto(`${base}${OVERLAY}`);
  await expect(viewer.locator('#mooncg-duplicate')).toBeVisible();
  const outcome = await viewer.evaluate(async () => {
    // What the control panel does, from a page of the same bundle the viewer may open. The
    // page says that it is no graphic, so that it is not refused as a second instance.
    const sdk = '/sdk/mooncg.js';
    const { createClient } = await import(sdk);
    const score = createClient({ graphic: undefined }).replicant('score');
    await score.ready;
    const read = `${score.value.home}:${score.value.away}`;
    try {
      await score.set({ home: 9, away: 9 });
      return `${read} written`;
    } catch (error) {
      return `${read} ${(error as { code?: string }).code ?? String(error)}`;
    }
  });
  expect(outcome).toMatch(/^\d+:\d+ forbidden$/);
  await expect(graphic.locator('#home')).not.toHaveText('9');
  await expect(graphic.locator('#mooncg-duplicate, #mooncg-ended')).toHaveCount(0);
});

/** The archive of a version of the bundle the test below installs. */
function tickerZip(version: string, extension = 'export default function start() {}') {
  return {
    name: `e2e-ticker-${version}.zip`,
    mimeType: 'application/zip',
    buffer: zipOf({
      'mooncg.json': {
        manifest: 1,
        kind: 'bundle',
        name: 'e2e-ticker',
        version,
        title: 'Ticker',
        extension: 'extension/index.js',
        permissions: { view: 'See the ticker' },
        panels: [{ id: 'lines', title: 'Lines', file: 'dashboard/lines.html', workspace: 'Show' }],
      },
      'extension/index.js': extension,
      'dashboard/lines.html': `<!doctype html><title>Lines</title><p id="version">ticker ${version}</p>`,
    }),
  };
}

test('a bundle: installed from a ZIP, updated, rolled back when broken, and removed', async ({
  browser,
}) => {
  const { problems, watch } = watcher();
  const admin = watch(await asAdmin(browser));
  const row = admin.locator('[data-bundle="e2e-ticker"]');
  const form = admin.locator('.install');
  const staged = admin.locator('[data-staged]');
  const lines = admin.frameLocator('iframe[title="Lines"]');
  const fact = (term: string) => staged.locator('.facts > div', { hasText: term }).locator('dd');
  /** Chooses the ZIP upload in the form and hands it the archive. */
  const upload = async (archive: ReturnType<typeof tickerZip>) => {
    await form.getByRole('radio', { name: 'ZIP upload' }).click();
    await form.locator('input[type="file"]').setInputFiles(archive);
  };

  // --- Fetched and checked first: the page shows what the bundle declares, and nothing runs.
  await nav(admin, 'Bundles').click();
  await expect(form.locator('h2')).toHaveText('Install bundle');
  await upload(tickerZip('1.0.0'));
  await expect(staged.locator('h2')).toHaveText('Ticker e2e-ticker 1.0.0');
  await expect(staged.locator('.badge')).toHaveText('New');
  await expect(fact('Source')).toHaveText('upload e2e-ticker-1.0.0.zip');
  await expect(fact('Server code')).toContainText('Yes');
  await expect(fact('Permissions')).toHaveText('view (See the ticker)');
  await expect(fact('Runs code on install')).toHaveText('No');
  await expect(fact('Role grants')).toHaveText('none');
  await expect(form.locator('input[name="scripts"]')).not.toBeChecked();
  await expect(fact('Provides')).toContainText('1 panel');
  await expect(row).toHaveCount(0);
  expect((await admin.request.get(`${base}/b/e2e-ticker/dashboard/lines.html`)).status()).toBe(404);
  // The styles of the summary are the design system's: a card, the terms muted.
  await expect(staged).toHaveCSS('background-color', 'rgb(27, 30, 36)');

  // --- Installed: it runs, and its panel is in the workspace.
  await staged.getByRole('button', { name: 'Install' }).click();
  await expect(row.locator('.state')).toHaveText('running');
  await expect(row.locator('small')).toHaveText('e2e-ticker 1.0.0');
  await expect(row.locator('.bundle-facts')).toContainText('from upload e2e-ticker-1.0.0.zip');
  await expect(staged).toHaveCount(0);
  await expect(form.locator('.done')).toHaveText('Installing e2e-ticker is done.');
  await nav(admin, 'Show').click();
  await expect(lines.locator('#version')).toHaveText('ticker 1.0.0');

  // --- Updated: the summary names both versions, and the new one runs.
  await nav(admin, 'Bundles').click();
  await row.getByRole('button', { name: 'Update' }).click();
  await expect(form.locator('h2')).toHaveText('Update e2e-ticker');
  await upload(tickerZip('1.1.0'));
  await expect(staged.locator('.badge')).toHaveText('Update of 1.0.0');
  await staged.getByRole('button', { name: 'Update' }).click();
  await expect(row.locator('small')).toHaveText('e2e-ticker 1.1.0');
  await expect(row.locator('.state')).toHaveText('running');
  await expect(form.locator('.done')).toHaveText('Updating e2e-ticker is done.');
  await nav(admin, 'Show').click();
  await expect(lines.locator('#version')).toHaveText('ticker 1.1.0');

  // --- A version that does not start is rolled back: the one before keeps running.
  await nav(admin, 'Bundles').click();
  await row.getByRole('button', { name: 'Update' }).click();
  await upload(
    tickerZip('2.0.0', 'export default function start() { throw new Error("no good"); }'),
  );
  await expect(staged.locator('.badge')).toHaveText('Update of 1.1.0');
  await staged.getByRole('button', { name: 'Update' }).click();
  await expect(form.locator('.problem')).toContainText('rolled back');
  await expect(form.locator('.problem')).toContainText('no good');
  await expect(row.locator('small')).toHaveText('e2e-ticker 1.1.0');
  await expect(row.locator('.state')).toHaveText('running');
  await expect(row.locator('.problem')).toHaveCount(0);
  await nav(admin, 'Show').click();
  await expect(lines.locator('#version')).toHaveText('ticker 1.1.0');
  // What was replaced before is kept; what failed is not.
  const backups = await admin.request.get(`${base}/api/v1/bundles/e2e-ticker/backups`);
  expect(((await backups.json()) as { backups: { version: string }[] }).backups).toMatchObject([
    { version: '1.0.0' },
  ]);

  // --- A viewer sees none of the controls and is refused by the API.
  const viewer = await asViewer(browser);
  await nav(viewer, 'Bundles').click();
  await expect(viewer.locator('[data-bundle="scoreboard"]')).toContainText('running');
  await expect(viewer.locator('.install, [data-staged]')).toHaveCount(0);
  await expect(viewer.locator('[data-bundle] button')).toHaveCount(0);
  await expect(viewer.locator('[data-bundle="scoreboard"]')).not.toContainText('from ');
  const refused = [
    await viewer.request.post(`${base}/api/v1/bundles/-/stage`, {
      data: { source: { type: 'git', url: 'https://example.org/x.git' } },
    }),
    await viewer.request.put(`${base}/api/v1/bundles/-/stage`, {
      data: tickerZip('9.0.0').buffer,
      headers: UPLOAD,
    }),
    await viewer.request.get(`${base}/api/v1/bundles/-/staged`),
    await viewer.request.get(`${base}/api/v1/bundles/-/jobs`),
    await viewer.request.post(`${base}/api/v1/bundles/e2e-ticker/update`, { data: {} }),
    await viewer.request.post(`${base}/api/v1/bundles/e2e-ticker/remove`, { data: {} }),
    await viewer.request.post(`${base}/api/v1/bundles/scoreboard/remove`, { data: {} }),
    await viewer.request.get(`${base}/api/v1/bundles/e2e-ticker/backups`),
  ];
  expect(refused.map((answer) => answer.status())).toEqual(refused.map(() => 403));
  // A bundle the viewer holds nothing of is not there for them.
  expect((await viewer.request.get(`${base}/b/e2e-ticker/dashboard/lines.html`)).status()).toBe(
    404,
  );

  // --- Removed, after a confirmation in its row that says what is kept: gone from the list
  // and from the server, and its files are a backup that can be restored.
  await nav(admin, 'Bundles').click();
  await expect(row.locator('.state')).toHaveText('running');
  const questions: string[] = [];
  admin.on('dialog', (dialog) => {
    questions.push(dialog.message());
    void dialog.accept();
  });
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  const confirmation = row.locator('[data-remove]');
  await expect(confirmation).toContainText('moved to the backups');
  await expect(confirmation).toContainText('the role grants for it are kept');
  await confirmation.getByRole('button', { name: 'Remove e2e-ticker' }).click();
  await expect(row).toHaveCount(0);
  await expect(form.locator('.done')).toHaveText('Removing e2e-ticker is done.');
  // Nothing needs it and nothing is on air: no further question.
  expect(questions).toEqual([]);
  const kept = admin.locator('[data-backup-of="e2e-ticker"]');
  await expect(kept).toContainText('removed');
  await expect(kept).toContainText('when it was removed');
  await expect(admin.locator('[data-bundle="scoreboard"] .state')).toHaveText('running');
  const gone = await viewer.request.get(`${base}/b/e2e-ticker/dashboard/lines.html`);
  expect(gone.status()).toBe(404);
  await nav(admin, 'Show').click();
  await expect(admin.locator('iframe[title="Lines"]')).toHaveCount(0);
  await expect(control(admin).locator('body')).toBeVisible();

  expect(problems).toEqual([]);
});

test('live reload: a changed panel reloads, a graphic is only marked, pages outlive a bundle reload, On Air holds changes back', async ({
  browser,
}) => {
  const { problems, watch } = watcher();
  const admin = watch(await asAdmin(browser));
  const file = (path: string) => join(bundlesDir, 'scoreboard', path);
  const controlHtml = await readFile(file('dashboard/control.html'), 'utf8');
  const overlayHtml = await readFile(file('graphics/overlay.html'), 'utf8');
  /** Marks a page, so that a later look tells whether it was loaded again. */
  const mark = (page: Page) =>
    page.evaluate(() => {
      (window as unknown as { kept?: boolean }).kept = true;
    });
  const kept = (page: Page) =>
    page.evaluate(() => (window as unknown as { kept?: boolean }).kept === true);

  // --- A panel file changes on disk: the panel in the dashboard loads itself again.
  await nav(admin, 'Show').click();
  await expect(control(admin).locator('#home')).toHaveText('Home +1');
  await writeFile(file('dashboard/control.html'), controlHtml.replace('Home +1', 'Home plus one'));
  await expect(control(admin).locator('#home')).toHaveText('Home plus one');

  // --- Two pages on their own, as in OBS or a second window: the panel and the graphic.
  const panel = watch(await admin.context().newPage());
  await panel.goto(`${base}/b/scoreboard/dashboard/control.html`);
  await expect(panel.locator('#score')).toHaveText(/^\d+:\d+$/);
  const graphic = watch(await admin.context().newPage());
  await graphic.goto(`${base}${OVERLAY}`);
  await expect(graphic.locator('#home')).toHaveText(/^\d+$/);
  await mark(panel);
  await mark(graphic);

  // --- The bundle is reloaded: its replicants go and come back, and both pages go on
  // working without being loaded again.
  const reloaded = await admin.request.post(`${base}/api/v1/bundles/scoreboard/reload`, {
    data: {},
  });
  expect(reloaded.status()).toBe(200);
  // The score is set back and counted up: the request reaches the extension that was
  // started again, and both pages follow the replicant that was declared again.
  await expect(async () => {
    await panel.locator('#reset').click();
    await expect(panel.locator('#score')).toHaveText('0:0', { timeout: 1000 });
    await panel.locator('#home').click();
    await expect(panel.locator('#score')).toHaveText('1:0', { timeout: 1000 });
    await expect(graphic.locator('#home')).toHaveText('1', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  expect(await kept(panel)).toBe(true);
  expect(await kept(graphic)).toBe(true);

  // --- A graphic file changes: outside dev mode nothing reloads what may be on air. The
  // graphics page marks the page as out of date, and reloads it when asked to.
  await nav(admin, 'Graphics').click();
  const listed = admin.locator('[data-graphic="scoreboard:overlay"]');
  await expect(listed.locator('[data-instance]')).toHaveCount(1);
  await writeFile(
    file('graphics/overlay.html'),
    overlayHtml.replace('<span>HOME</span>', '<span>HEIM</span>'),
  );
  await expect(listed.locator('[data-badge="out-of-date"]')).toHaveText('Out of date');
  expect(await kept(graphic)).toBe(true);
  await expect(graphic.locator('#board')).toContainText('HOME');
  await Promise.all([
    graphic.waitForEvent('framenavigated'),
    listed.locator('[data-instance]').getByRole('button', { name: 'Reload' }).click(),
  ]);
  await expect(graphic.locator('#board')).toContainText('HEIM');
  await expect(listed.locator('[data-instance]')).toHaveCount(1);
  await expect(listed.locator('[data-badge="out-of-date"]')).toHaveCount(0);

  // --- On Air: the switch is there for who manages bundles, and says where it stands.
  const onAir = admin.locator('[data-on-air]');
  await expect(onAir).toHaveAttribute('data-on-air', 'false');
  await admin.locator('#on-air-switch').click();
  await expect(onAir).toHaveAttribute('data-on-air', 'true');
  await expect(onAir).toContainText('On Air');
  // A reload is refused now, unless it overrides the lock.
  const refused = await admin.request.post(`${base}/api/v1/bundles/scoreboard/reload`, {
    data: {},
  });
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
    'on air',
  );

  // --- A panel file changes while on air: it waits, and the bundles page says so.
  await mark(panel);
  await writeFile(file('dashboard/control.html'), controlHtml.replace('Home +1', 'Home again'));
  await nav(admin, 'Bundles').click();
  const row = admin.locator('[data-bundle="scoreboard"]');
  await expect(row.locator('[data-badge="pending"]')).toHaveText('changes pending');
  await expect(admin.locator('[data-on-air-note]')).toBeVisible();
  expect(await kept(panel)).toBe(true);
  await expect(panel.locator('#home')).toHaveText('Home plus one');

  // --- Ending On Air applies what waited, after a question that names the bundle.
  const questions: string[] = [];
  admin.once('dialog', (dialog) => {
    questions.push(dialog.message());
    void dialog.accept();
  });
  await admin.locator('#on-air-switch').click();
  await expect(onAir).toHaveAttribute('data-on-air', 'false');
  await expect(panel.locator('#home')).toHaveText('Home again');
  await expect(row.locator('[data-badge="pending"]')).toHaveCount(0);
  expect(questions).toHaveLength(1);
  expect(questions[0]).toContain('scoreboard');

  // --- An invalid manifest is not applied: the bundle keeps running and says why.
  const manifest = await readFile(file('mooncg.json'), 'utf8');
  await writeFile(file('mooncg.json'), '{ "manifest": 1,');
  await expect(row.locator('[data-badge="not-reloaded"]')).toHaveText('not reloaded');
  await expect(row.locator('.state')).toHaveText('running');
  await expect(row).toContainText('mooncg.json is not valid JSON');
  await writeFile(file('mooncg.json'), manifest);
  await expect(row.locator('[data-badge="not-reloaded"]')).toHaveCount(0);
  await expect(row.locator('.state')).toHaveText('running');

  // The example is left as it was found.
  await writeFile(file('dashboard/control.html'), controlHtml);
  await writeFile(file('graphics/overlay.html'), overlayHtml);
  await expect(panel.locator('#home')).toHaveText('Home +1');

  expect(problems).toEqual([]);
});

test('an external login: the module enabled, an account linked, signed in through the provider', async ({
  browser,
}) => {
  // An identity provider on this machine, which signs in whoever comes as one account.
  const idp = await startMockIdp();
  idp.browserAccount = { sub: 'idp-vera-1', preferred_username: 'someone.else' };
  const admin = await asAdmin(browser);
  try {
    // --- The settings of the module that MoonCG ships, and the module itself, which does
    // nothing until an administrator turns it on.
    const saved = await admin.request.put(`${base}/api/v1/modules/auth-oidc/config`, {
      data: {
        values: {
          oidc: {
            enabled: true,
            name: 'Mock Provider',
            issuer: idp.issuer,
            clientId: idp.clientId,
            clientSecret: idp.clientSecret,
          },
        },
      },
    });
    expect(saved.status()).toBe(200);
    expect(await saved.text()).not.toContain(idp.clientSecret);
    await nav(admin, 'Modules').click();
    const row = admin.locator('[data-module="auth-oidc"]');
    await expect(row.locator('.state')).toHaveText('disabled');
    await row.locator('[data-action="enable"]').click();
    await expect(row.locator('.state')).toHaveText('running');
    await expect(row).toContainText('Sign-in: oidc');

    // --- Nobody is linked: the account is refused, and no user is made of it.
    const visitor = await freshPage(browser);
    await visitor.goto(`${base}/login`);
    const button = visitor.getByRole('link', { name: 'Sign in with Mock Provider' });
    await button.click();
    await visitor.waitForURL(`${base}/login`);
    await expect(visitor.locator('#notice')).toContainText('not linked to a user');

    // --- The administrator sees who tried and links the account to the viewer.
    await nav(admin, 'Users').click();
    const attempt = admin.locator('[data-unlinked="oidc:idp-vera-1"]');
    await expect(attempt).toContainText('someone.else');
    await attempt.locator('select').selectOption({ label: 'vera' });
    await attempt.locator('[data-action="link"]').click();
    await expect(admin.locator('[data-user="vera"] [data-identity="oidc"]')).toContainText(
      'idp-vera-1',
    );
    await expect(attempt).toHaveCount(0);

    // --- Now the same account signs in, as the viewer and as nobody else.
    const { problems, watch } = watcher();
    watch(visitor);
    await visitor.goto(`${base}/login`);
    await visitor.getByRole('link', { name: 'Sign in with Mock Provider' }).click();
    await visitor.waitForURL(`${base}/`);
    await expect(visitor.locator('[data-user-name]')).toHaveText('vera');
    await expect(nav(visitor, 'Users')).toHaveCount(0);
    const cookies = await visitor.context().cookies(base);
    const session = cookies.find((cookie) => cookie.name === 'mooncg_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    // The cookie of the sign-in itself is used up and gone.
    expect(cookies.some((cookie) => cookie.name === 'mooncg_oauth')).toBe(false);
    expect(problems).toEqual([]);

    // --- Unlinking signs the viewer out, and the account is refused again.
    await admin.reload();
    admin.once('dialog', (dialog) => void dialog.accept());
    await admin.locator('[data-user="vera"] [data-action="unlink"]').click();
    await expect(admin.locator('[data-user="vera"] [data-identity]')).toHaveCount(0);
    const me = await visitor.request.get(`${base}/api/v1/me`);
    expect(me.status()).toBe(401);
  } finally {
    // The server is shared: the next test finds it without the provider.
    await admin.request.post(`${base}/api/v1/modules/auth-oidc/disable`, { data: {} });
    await idp.close();
  }
});
