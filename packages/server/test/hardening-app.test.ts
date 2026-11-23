import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type Policy, type Principal, ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBundles } from '../src/bundles/bundles.js';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { type AppOptions, createApp } from '../src/http/app.js';
import { fixture, memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  await temporary.cleanup();
});

async function appFor(bundlesDir: string, overrides: Partial<AppOptions> = {}) {
  const registry = new ReplicantRegistry();
  const { logger } = memoryLogger();
  const bundles = await loadBundles({
    bundlesDir,
    registry,
    host: new InlineHost({ registry, logger }),
    logger,
  });
  const app = await createApp({ bundles, sdkFile: undefined, ...overrides });
  apps.push(app);
  return app;
}

/** May view the `good` bundle's graphic but not operate its panel. */
const viewer: Principal = { id: 'viewer', roles: ['viewer'] };
const viewerPolicy: Policy = { roles: { viewer: ['system:dashboard.view', 'bundle:good:view'] } };

describe('file name case', () => {
  it.each([
    ['/b/good/dashboard/Control.html'],
    ['/b/good/dashboard/CONTROL.HTML'],
    ['/b/good/Dashboard/control.html'],
    ['/b/GOOD/dashboard/control.html'],
    ['/b/good/graphics/Overlay.html'],
  ])('answers 404 for the case variant %s', async (url) => {
    const app = await appFor(fixture('bundles'));
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('good control panel');
  });

  it('never serves a panel to someone without its permission through a case variant', async () => {
    const app = await appFor(fixture('bundles'), {
      policy: viewerPolicy,
      resolvePrincipal: () => viewer,
    });

    const exact = await app.inject({ url: '/b/good/dashboard/control.html' });
    const variant = await app.inject({ url: '/b/good/dashboard/Control.html' });

    expect(exact.statusCode).toBe(403);
    expect([403, 404]).toContain(variant.statusCode);
    expect(variant.body).not.toContain('good control panel');
  });
});

describe('links out of the served folders', () => {
  it('does not follow a directory link that leaves dashboard/', async () => {
    const dir = await temporary.create({
      'linky/mooncg.json': manifest('linky'),
      'linky/dashboard/inside.html': 'inside',
      'linky/private/secret.txt': 'top secret',
      'linky/dashboard/sub/nested.html': 'nested',
    });
    // A junction needs no special privilege on Windows; elsewhere this is a plain symlink.
    await symlink(
      join(dir, 'linky', 'private'),
      join(dir, 'linky', 'dashboard', 'out'),
      'junction',
    );
    await symlink(
      join(dir, 'linky', 'dashboard', 'sub'),
      join(dir, 'linky', 'dashboard', 'alias'),
      'junction',
    );
    const app = await appFor(dir);

    const inside = await app.inject({ url: '/b/linky/dashboard/inside.html' });
    const nested = await app.inject({ url: '/b/linky/dashboard/sub/nested.html' });
    const escaped = await app.inject({ url: '/b/linky/dashboard/out/secret.txt' });
    const aliased = await app.inject({ url: '/b/linky/dashboard/alias/nested.html' });

    expect(inside.body).toBe('inside');
    expect(nested.body).toBe('nested');
    expect(escaped.statusCode).toBe(404);
    expect(escaped.body).not.toContain('top secret');
    expect(aliased.statusCode).toBe(404);
  });
});

describe('panel and graphic URLs', () => {
  it('percent-encodes file names and serves the encoded URL', async () => {
    const dir = await temporary.create({
      'odd/mooncg.json': manifest('odd', {
        panels: [{ id: 'p', title: 'P', file: 'dashboard/my panel #1.html' }],
        graphics: [{ id: 'g', file: 'graphics/50%/a&b.html', width: 1920, height: 1080 }],
      }),
      'odd/dashboard/my panel #1.html': 'odd panel',
      'odd/graphics/50%/a&b.html': 'odd graphic',
    });
    const app = await appFor(dir);

    const { bundles } = (await app.inject({ url: '/api/v1/bundles' })).json();
    const panelUrl = bundles[0].panels[0].url;
    const graphicUrl = bundles[0].graphics[0].url;

    expect(panelUrl).toBe('/b/odd/dashboard/my%20panel%20%231.html');
    expect(graphicUrl).toBe('/b/odd/graphics/50%25/a%26b.html');
    expect((await app.inject({ url: panelUrl })).body).toBe('odd panel');
    expect((await app.inject({ url: graphicUrl })).body).toBe('odd graphic');
  });
});
