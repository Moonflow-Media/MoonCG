import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { findNpmCli } from '../packages/server/src/install/npm.js';

/**
 * The `vue` template with a real Vite development server and MoonCG in dev mode, in
 * Chromium: the panel is sent on to Vite, connects its WebSocket through Vite's proxy, reads
 * and writes a replicant, a saved component is applied by hot module replacement, and a panel
 * of Vite opens a dialog, also served by Vite, inside the dashboard.
 *
 * Opt-in: it installs Vite from the npm registry, so it needs the network and takes a while.
 * Run it with `MOONCG_VITE_E2E=1 pnpm test:e2e`.
 */

const repo = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const START_TIMEOUT_MS = 60_000;

test.skip(process.env.MOONCG_VITE_E2E !== '1', 'Set MOONCG_VITE_E2E=1 to run it');
test.describe.configure({ timeout: 240_000 });

const processes: ChildProcess[] = [];
let installation: string;

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** Starts a program and resolves once its output matches `ready`, with the match. */
function start(
  command: string,
  args: string[],
  cwd: string,
  ready: RegExp,
  env: NodeJS.ProcessEnv = process.env,
) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  processes.push(child);
  let output = '';
  return new Promise<RegExpExecArray>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${args[0]} did not start:\n${output}`)),
      START_TIMEOUT_MS,
    );
    const read = (chunk: Buffer) => {
      // Without the colours Vite prints.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
      output += chunk.toString().replace(/\u001b\[[0-9;]*m/g, '');
      const match = ready.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve(match);
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('exit', (code) => reject(new Error(`${args[0]} exited with ${code}:\n${output}`)));
  });
}

test.afterAll(async () => {
  for (const child of processes) {
    if (child.exitCode !== null) continue;
    const gone = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await gone;
  }
  if (installation) {
    await rm(installation, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a panel served by Vite works against MoonCG in dev mode, with HMR', async ({ page }) => {
  // The long name of the folder: Vite started from a short 8.3 path on Windows answers 404
  // for its own client script.
  installation = await mkdtemp(join(realpathSync.native(tmpdir()), 'mooncg-vite-e2e-'));
  const cli = join(repo, 'packages/cli/dist/main.js');
  await run(process.execPath, [cli, 'init'], { cwd: installation });
  await run(process.execPath, [cli, 'bundle', 'create', 'demo', '--template', 'vue'], {
    cwd: installation,
  });
  const bundle = join(installation, 'bundles', 'demo');
  const vitePort = await freePort();
  // The port the template names is 5173; this test takes a free one for both servers.
  const manifestFile = join(bundle, 'mooncg.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.dev.url = `http://localhost:${vitePort}/b/demo/`;
  // A panel that asks in a dialog, and the dialog: pages of the development server both.
  manifest.panels.push({ id: 'opener', title: 'Opener', file: 'dashboard/opener.html' });
  manifest.dialogs = [{ id: 'ask', title: 'Ask', file: 'dashboard/ask.html' }];
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  const htmlPage = (title: string, body: string, script: string) =>
    `<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><title>${title}</title></head>\n  <body>\n    ${body}\n    <script type="module" src="./${script}"></script>\n  </body>\n</html>\n`;
  await writeFile(
    join(bundle, 'src/dashboard/opener.html'),
    htmlPage(
      'Opener',
      '<button id="ask" type="button" disabled>Ask</button><p id="answer"></p>',
      'opener.js',
    ),
  );
  await writeFile(
    join(bundle, 'src/dashboard/opener.js'),
    `import { mc } from '../client.js';
document.getElementById('ask').addEventListener('click', async () => {
  try {
    const answer = await mc.dialogs.open('ask', { question: 'Go on air?' });
    document.getElementById('answer').textContent = JSON.stringify(answer);
  } catch (error) {
    document.getElementById('answer').textContent = 'error ' + error.code;
  }
});
// Clickable once it does something: Vite may load the script after the button shows.
document.getElementById('ask').disabled = false;
`,
  );
  await writeFile(
    join(bundle, 'src/dashboard/ask.html'),
    htmlPage(
      'Ask',
      '<p id="question"></p><button id="yes" type="button" disabled>Yes</button>',
      'ask.js',
    ),
  );
  await writeFile(
    join(bundle, 'src/dashboard/ask.js'),
    `import { mc } from '../client.js';
const dialog = await mc.dialogs.current();
document.getElementById('question').textContent = dialog.data.question;
document.getElementById('yes').addEventListener('click', () => dialog.close('yes'));
document.getElementById('yes').disabled = false;
`,
  );
  const npm = findNpmCli();
  if (npm === undefined) throw new Error('npm was not found beside node');
  await run(process.execPath, [npm, 'install', '--no-audit', '--no-fund'], { cwd: bundle });

  const [, mooncg] = await start(
    process.execPath,
    [join(repo, 'packages/server/dist/main.js'), '--dev', '--port', '0', '--host', 'localhost'],
    installation,
    /listening on (http:\/\/\S+)/,
  );
  await start(
    process.execPath,
    [join(bundle, 'node_modules/vite/bin/vite.js'), '--port', String(vitePort), '--strictPort'],
    bundle,
    /ready in/,
    { ...process.env, MOONCG_URL: mooncg },
  );
  // Vite hands what is MoonCG's to the server this test started.
  expect(mooncg).toMatch(/^http:\/\/localhost:\d+$/);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // The panel's address at MoonCG: dev mode sends it on to Vite.
  await page.goto(`${mooncg}/b/demo/dashboard/control.html`);
  expect(page.url()).toBe(`http://localhost:${vitePort}/b/demo/dashboard/control.html`);
  const text = page.locator('input[name="text"]');
  await expect(text).toHaveValue('Hello from Demo');

  // Writing: the graphic, also served by Vite, shows what the panel set.
  const graphic = await page.context().newPage();
  await graphic.goto(`${mooncg}/b/demo/graphics/overlay.html`);
  await expect(graphic.locator('#message')).toHaveText('Hello from Demo');
  await text.fill('Written from the panel');
  await text.dispatchEvent('change');
  await expect(graphic.locator('#message')).toHaveText('Written from the panel');
  // The graphic was listed as an instance of its graphic: it said which one it is.
  const instances = await page.request.get(`${mooncg}/api/v1/bundles/demo/instances`);
  expect(instances.ok()).toBe(true);
  expect(JSON.stringify(await instances.json())).toContain('overlay');

  // HMR: a saved component is applied without a reload of the page.
  await page.evaluate(() => {
    (globalThis as { __kept?: boolean }).__kept = true;
  });
  const component = join(bundle, 'src/dashboard/Control.vue');
  const source = await readFile(component, 'utf8');
  await writeFile(component, source.replace('Visible\n', 'Shown on air\n'));
  await expect(page.locator('label.check')).toContainText('Shown on air');
  expect(await page.evaluate(() => (globalThis as { __kept?: boolean }).__kept)).toBe(true);
  // The replicant is still there after the update.
  await expect(text).toHaveValue('Written from the panel');
  expect(errors).toEqual([]);

  // Dialogs: in the dashboard, a panel of Vite opens a dialog page of Vite. The dashboard
  // believes both from the origin of the bundle's development server, and answers there alone.
  const dashboard = await page.context().newPage();
  dashboard.on('pageerror', (error) => errors.push(error.message));
  await dashboard.goto(`${mooncg}/w/Main`);
  const opener = dashboard.frameLocator('iframe[data-panel-bundle="demo"][src*="opener.html"]');
  await opener.locator('#ask').click();
  const dialog = dashboard.locator('[role="dialog"]');
  await expect(dialog).toHaveAttribute('data-dialog', 'demo:ask');
  const asked = dashboard.frameLocator('[role="dialog"] iframe');
  await expect(asked.locator('#question')).toHaveText('Go on air?');
  // Really served by Vite: the frame was sent on to the development server.
  const frames = dashboard.frames().map((frame) => frame.url());
  expect(
    frames.some((url) => url.startsWith(`http://localhost:${vitePort}/b/demo/dashboard/ask.html`)),
  ).toBe(true);
  await asked.locator('#yes').click();
  await expect(dialog).toHaveCount(0);
  await expect(opener.locator('#answer')).toHaveText('"yes"');
  await dashboard.close();
  expect(errors).toEqual([]);

  // The built files: without "dev.url" MoonCG serves dashboard/ and graphics/ itself.
  await run(process.execPath, [join(bundle, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: bundle,
  });
  delete manifest.dev;
  // The pages of the dialog test are not built; without them the built bundle has neither.
  manifest.panels = manifest.panels.filter((panel: { id: string }) => panel.id !== 'opener');
  delete manifest.dialogs;
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  await expect(async () => {
    const answer = await page.request.get(`${mooncg}/b/demo/dashboard/control.html`, {
      maxRedirects: 0,
    });
    expect(answer.status()).toBe(200);
  }).toPass({ timeout: 20_000 });
  await page.goto(`${mooncg}/b/demo/dashboard/control.html`);
  expect(page.url()).toBe(`${mooncg}/b/demo/dashboard/control.html`);
  await expect(page.locator('input[name="text"]')).toHaveValue('Written from the panel');
  await graphic.goto(`${mooncg}/b/demo/graphics/overlay.html`);
  await expect(graphic.locator('#message')).toHaveText('Written from the panel');
  expect(errors).toEqual([]);
});
