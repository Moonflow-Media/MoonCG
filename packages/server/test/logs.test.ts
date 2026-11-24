import { afterEach, describe, expect, it } from 'vitest';
import { createLogBuffer, createLogger, recordingLogger } from '../src/kernel/logger.js';
import { PASSWORD, startAuthServer, startWithRoles } from './auth-helpers.js';
import { temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

describe('the log buffer', () => {
  it('keeps the latest entries with a rising id, a time and a level', () => {
    const logs = createLogBuffer({ limit: 3, now: () => 1_700_000_000_000 });
    for (const text of ['one', 'two', 'three', 'four']) logs.add('info', text);
    logs.add('error', 'five');
    expect(logs.entries()).toEqual([
      { id: 3, time: '2023-11-14T22:13:20.000Z', level: 'info', text: 'three' },
      { id: 4, time: '2023-11-14T22:13:20.000Z', level: 'info', text: 'four' },
      { id: 5, time: '2023-11-14T22:13:20.000Z', level: 'error', text: 'five' },
    ]);
    expect(logs.entries(4).map((entry) => entry.id)).toEqual([5]);
    expect(logs.entries(99)).toEqual([]);
  });

  it('never holds an API token or a setup code, and bounds the length of a line', () => {
    const logs = createLogBuffer();
    logs.add(
      'info',
      'Create the first administrator at http://127.0.0.1:9090/setup?code=Abc-123_x',
    );
    logs.add('warn', 'GET /b/x/graphics/a.html?token=mcg_Secret-1_x&code=zzz failed');
    logs.add('info', 'x'.repeat(10_000));
    const text = logs.entries().map((entry) => entry.text);
    expect(text[0]).toBe('Create the first administrator at http://127.0.0.1:9090/setup?code=***');
    expect(text[1]).toBe('GET /b/x/graphics/a.html?token=mcg_***&code=*** failed');
    expect(text[2]?.length).toBeLessThanOrEqual(2001);
  });

  it('records what a logger and its children log, and still passes it on', () => {
    const lines: string[] = [];
    const logs = createLogBuffer();
    const logger = recordingLogger(
      createLogger((line) => lines.push(line)),
      logs,
    );
    logger.info('started');
    logger.child('bundle:board').error('broke');
    expect(lines).toEqual(['INFO  started', 'ERROR [bundle:board] broke']);
    expect(logs.entries().map(({ level, text }) => `${level} ${text}`)).toEqual([
      'info started',
      'error [bundle:board] broke',
    ]);
  });
});

describe('GET /api/v1/logs', () => {
  it('answers what the server logged, to whoever may view logs', async () => {
    const { http, cookies, server, auth } = await startWithRoles(temporary);
    cleanup.push(() => server.close());
    server.logger.warn('something odd with mcg_Token-Value_1');
    const answer = await http('GET', '/api/v1/logs', { cookie: cookies.admin });
    expect(answer.status).toBe(200);
    const { entries, last } = answer.json as {
      entries: { id: number; level: string; text: string }[];
      last: number;
    };
    expect(entries.at(-1)).toMatchObject({ level: 'warn', text: 'something odd with mcg_***' });
    expect(last).toBe(entries.at(-1)?.id);
    expect(answer.text).not.toContain('Token-Value');

    server.logger.error('later');
    const tail = await http('GET', `/api/v1/logs?after=${last}`, { cookie: cookies.admin });
    expect(tail.json.entries.map((entry: { text: string }) => entry.text)).toEqual(['later']);
    // A page that asks for what follows a line this server never had, as after a restart,
    // is told where the log really ends, so that it can start over.
    const ahead = await http('GET', '/api/v1/logs?after=999999', { cookie: cookies.admin });
    expect(ahead.json).toEqual({ entries: [], last: tail.json.last });
    expect(
      (await http('GET', '/api/v1/logs?after=nonsense', { cookie: cookies.admin })).status,
    ).toBe(400);

    for (const role of ['operator', 'viewer', 'graphics'] as const) {
      expect((await http('GET', '/api/v1/logs', { cookie: cookies[role] })).status).toBe(403);
    }
    expect((await http('GET', '/api/v1/logs')).status).toBe(401);
    auth.grant('operator', 'system:logs.view');
    expect((await http('GET', '/api/v1/logs', { cookie: cookies.operator })).status).toBe(200);
  });

  it('does not hand out the setup code', async () => {
    const context = await startAuthServer(temporary);
    cleanup.push(() => context.server.close());
    const code = new URL(context.server.setupUrl as string).searchParams.get('code') as string;
    await context.auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
    const answer = await context.http('GET', '/api/v1/logs', {
      cookie: await context.login('ada'),
    });
    expect(answer.text).toContain('setup?code=***');
    expect(answer.text).not.toContain(code);
  });
});

describe('a preference that was never stored', () => {
  it('answers null without an error, and 404 only for a key that cannot be one', async () => {
    const { http, cookies, server } = await startWithRoles(temporary);
    cleanup.push(() => server.close());
    const mine = { cookie: cookies.operator };
    const missing = await http('GET', '/api/v1/me/prefs/layout.show', mine);
    expect([missing.status, missing.json]).toEqual([200, { value: null }]);
    expect((await http('GET', '/api/v1/me/prefs/Bad%20Key', mine)).status).toBe(404);
  });
});
