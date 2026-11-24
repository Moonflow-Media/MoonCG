import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

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
let base: string;
let setupUrl: string;
const contexts: BrowserContext[] = [];

/** Starts the built server on a free port and waits until it has said where it listens. */
test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mooncg-e2e-'));
  server = spawn(
    process.execPath,
    [
      join(repo, 'packages/server/dist/main.js'),
      '--port',
      '0',
      '--bundles-dir',
      join(repo, 'examples'),
      '--data-dir',
      dataDir,
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
  await expect(group('System')).toHaveText([/^Settings$/, /^Logs/]);
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
  await expect(admin.locator('.empty')).toHaveText('No bundle is disabled.');
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
