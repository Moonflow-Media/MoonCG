import { describe, expect, it } from 'vitest';
import { publicError } from '../src/bundles/errors.js';
import { createLogLimiter } from '../src/extension-host/log-limiter.js';

describe('publicError', () => {
  const windowsBundle = 'D:\\Shows\\My Show\\bundles\\game';
  const windowsRoots = ['C:\\Program Files\\mooncg', 'C:\\Users\\someone'];

  it('makes a Windows path inside the bundle relative to it', () => {
    const message =
      '"schemas/score.json" could not be read: ENOENT: no such file or directory, open \'D:\\Shows\\My Show\\bundles\\game\\schemas\\score.json\'';
    expect(publicError(message, windowsBundle, windowsRoots)).toBe(
      '"schemas/score.json" could not be read: ENOENT: no such file or directory, open \'schemas/score.json\'',
    );
  });

  it('matches the bundle folder whatever the case and the slashes', () => {
    const message = 'Cannot load d:/shows/my show/BUNDLES/game/extension/index.js';
    expect(publicError(message, windowsBundle, windowsRoots)).toBe(
      'Cannot load extension/index.js',
    );
  });

  it('resolves file URLs, also with encoded characters', () => {
    const message =
      "Cannot find module 'file:///D:/Shows/My%20Show/bundles/game/extension/missing.js' imported from file:///C:/Program%20Files/mooncg/packages/server/dist/extension-host/worker-main.js";
    expect(publicError(message, windowsBundle, windowsRoots)).toBe(
      "Cannot find module 'extension/missing.js' imported from worker-main.js",
    );
  });

  it('reduces any other Windows path to its file name', () => {
    const message = 'EPERM: operation not permitted, open "C:\\Users\\someone\\secret\\notes.txt"';
    expect(publicError(message, windowsBundle, windowsRoots)).toBe(
      'EPERM: operation not permitted, open "notes.txt"',
    );
    expect(publicError('Failed at E:\\elsewhere\\deep\\file.js:12:5', windowsBundle, [])).toBe(
      'Failed at file.js:12:5',
    );
  });

  it('names the bundle folder itself as "."', () => {
    expect(publicError(`EACCES: scandir '${windowsBundle}'`, windowsBundle, [])).toBe(
      "EACCES: scandir '.'",
    );
  });

  it('does the same for POSIX paths under the bundle and under known roots', () => {
    const bundle = '/srv/show/bundles/game';
    const roots = ['/opt/mooncg', '/home/someone'];
    expect(
      publicError(
        "Cannot find module '/srv/show/bundles/game/extension/missing.js' imported from /opt/mooncg/dist/worker-main.js",
        bundle,
        roots,
      ),
    ).toBe("Cannot find module 'extension/missing.js' imported from worker-main.js");
    expect(publicError('open /home/someone/.ssh/id_rsa failed', bundle, roots)).toBe(
      'open id_rsa failed',
    );
  });

  it('leaves text that only looks like a path alone', () => {
    const bundle = '/srv/show/bundles/game';
    for (const message of [
      '/home: must be >= 0',
      '/teams/1: must be string',
      'replicants.score.default: does not match the schema: /home/away: must be integer',
      'needs version ^2.0.0, but 1.4.0 is installed',
      'Extension failed to start: boom',
    ]) {
      expect(publicError(message, bundle, ['/opt/mooncg'])).toBe(message);
    }
  });
});

describe('createLogLimiter', () => {
  function setup(limits: { maxLines?: number; maxBytes?: number } = {}) {
    let now = 0;
    const limiter = createLogLimiter({
      maxLines: 3,
      maxBytes: 100,
      windowMs: 1000,
      ...limits,
      now: () => now,
    });
    return {
      limiter,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('lets lines through up to the limit of a window and counts the rest', () => {
    const { limiter } = setup();
    const results = ['a', 'b', 'c', 'd', 'e'].map((line) => limiter.accept(line));
    expect(results).toEqual([
      { write: true, dropped: 0 },
      { write: true, dropped: 0 },
      { write: true, dropped: 0 },
      { write: false, dropped: 0 },
      { write: false, dropped: 0 },
    ]);
  });

  it('reports how many lines were dropped once, when the next window starts', () => {
    const { limiter, advance } = setup();
    for (const line of ['a', 'b', 'c', 'd', 'e']) limiter.accept(line);

    advance(1000);

    expect(limiter.accept('f')).toEqual({ write: true, dropped: 2 });
    expect(limiter.accept('g')).toEqual({ write: true, dropped: 0 });
  });

  it('also limits the bytes of a window', () => {
    const { limiter } = setup({ maxLines: 100 });
    expect(limiter.accept('x'.repeat(60)).write).toBe(true);
    expect(limiter.accept('x'.repeat(60)).write).toBe(false);
    expect(limiter.accept('short').write).toBe(true);
  });

  it('hands out what is still unreported when asked, for when the extension stops', () => {
    const { limiter } = setup();
    for (const line of ['a', 'b', 'c', 'd']) limiter.accept(line);
    expect(limiter.takeDropped()).toBe(1);
    expect(limiter.takeDropped()).toBe(0);
  });
});
