import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { type RunningProcess, runServer } from '../src/run.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { fixture, memoryLogger } from './helpers.js';

const running: RunningProcess[] = [];
const created: string[] = [];
afterEach(async () => {
  for (const process of running.splice(0)) await process.stop();
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function run(argv: string[], files: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'mooncg-run-'));
  created.push(cwd);
  for (const [name, text] of Object.entries(files)) await writeFile(join(cwd, name), text);
  const { logger, lines } = memoryLogger();
  const process = await runServer(
    { argv: ['--port', '0', '--bundles-dir', fixture('bundles'), ...argv], env: {}, cwd },
    {
      logger,
      storage: memoryStorage(),
      createHost: (services) => new InlineHost(services),
      passwordCost: { N: 16, r: 1, p: 1 },
      // Nothing of the process is touched by a test.
      signals: false,
    },
  );
  running.push(process);
  return { ...process, lines, cwd };
}

describe('runServer', () => {
  it('starts a server from flags and says where it listens', async () => {
    const { server, lines } = await run([]);
    await server.started;

    expect((await fetch(`${server.url}/login`)).status).toBe(200);
    expect(lines.some((line) => line.includes(`MoonCG is listening on ${server.url}`))).toBe(true);
    expect(server.watchers).toBeUndefined();
    expect(lines.join('\n')).not.toContain('DEV MODE');
    // Nobody is signed in by coming from this machine.
    expect((await fetch(`${server.url}/api/v1/me`)).status).toBe(401);
  });

  it('reads mooncg.config.json of the working directory, and lets flags win', async () => {
    const { server, lines, cwd } = await run([], {
      'mooncg.config.json': JSON.stringify({ port: 1, dataDir: 'my-data', watch: false }),
    });
    // The flag --port 0 won over the file, or nothing would listen.
    expect(server.port).toBeGreaterThan(1);
    expect(lines.join('\n')).toContain(join(cwd, 'my-data'));
    expect(lines.join('\n')).toContain(join(cwd, 'mooncg.config.json'));
  });

  it('fails on a configuration file that is wrong, naming it', async () => {
    await expect(run([], { 'mooncg.config.json': '{ "prot": 9090 }' })).rejects.toThrow(
      /mooncg\.config\.json.*"prot"/s,
    );
  });

  it('runs in dev mode with --dev: watcher on, signed in from this machine, and says so', async () => {
    const { server, lines } = await run(['--dev']);

    expect(server.watchers).toBeDefined();
    expect((await fetch(`${server.url}/api/v1/me`)).status).toBe(200);
    expect(lines.some((line) => line.includes('DEV MODE') && line.includes('WARN'))).toBe(true);
  });

  it('refuses dev mode on a host the network reaches', async () => {
    await expect(run(['--dev', '--host', '0.0.0.0'])).rejects.toThrow(/loopback/);
  });

  it('stops: the port is free again and nothing is watched', async () => {
    const { server, stop } = await run(['--watch']);
    await stop();

    await expect(fetch(`${server.url}/login`)).rejects.toThrow();
    expect(server.watchers?.watching()).toEqual([]);
  });
});
