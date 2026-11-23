import { MoonCGError, PROTOCOL_VERSION } from '@mooncg/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAME, type Score, setup, tick, withScore } from './fake-socket.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('after close()', () => {
  it('rejects the ready promise and writes of a replicant that never loaded', async () => {
    const { client, socket } = setup();
    socket().welcome();
    const score = client.replicant<Score>('score');
    const write = score.set({ home: 1, away: 1 });

    client.close();

    await expect(score.ready).rejects.toBeInstanceOf(MoonCGError);
    await expect(score.ready).rejects.toMatchObject({ code: 'disconnected' });
    await expect(write).rejects.toMatchObject({ code: 'disconnected' });
    await expect(score.update(() => {})).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('rejects pending ops and later writes of a loaded replicant', async () => {
    const { client, score } = await withScore();
    const pending = score.set({ home: 1, away: 1 });
    await tick();

    client.close();

    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
    await expect(score.set({ home: 2, away: 2 })).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('rejects the ready promise of a replicant requested afterwards', async () => {
    const { client, socket } = setup();
    socket().welcome();
    client.close();

    const late = client.replicant('late');

    await expect(late.ready).rejects.toMatchObject({ code: 'disconnected' });
    expect(socket().sent.some((msg) => msg.t === 'rep.sub')).toBe(false);
  });

  it('rejects the client ready promise when closed before the handshake', async () => {
    const { client } = setup();
    client.close();
    await expect(client.ready).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('after a refused hello', () => {
  it('rejects replicant ready promises and writes with the refusal', async () => {
    const { client, socket } = setup();
    const score = client.replicant<Score>('score');
    const write = score.set({ home: 1, away: 1 });
    socket().open();

    socket().receive({ t: 'err', code: 'bad_request', message: 'Unsupported protocol version' });

    await expect(score.ready).rejects.toMatchObject({
      code: 'bad_request',
      message: 'Unsupported protocol version',
    });
    await expect(write).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('does the same when the server answers with another protocol version', async () => {
    const { client, socket } = setup();
    const score = client.replicant<Score>('score');
    socket().open();

    socket().receive({ t: 'welcome', v: PROTOCOL_VERSION + 1 });

    await expect(score.ready).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('failing subscribers and patches', () => {
  it('keeps notifying the other subscribers and reports the failure', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { socket, score } = await withScore();
    const failure = new Error('subscriber failure');
    const seen: number[] = [];
    score.subscribe((_value, meta) => {
      if (meta.rev > 0) throw failure;
    });
    score.subscribe((_value, meta) => seen.push(meta.rev));

    const patch = (rev: number) =>
      socket().receive({
        t: 'rep.patch',
        name: NAME,
        rev,
        patches: [{ op: 'replace', path: '/home', value: rev }],
      });

    expect(() => patch(1)).not.toThrow();
    patch(2);

    expect(seen).toEqual([0, 1, 2]);
    expect(score.value).toEqual({ home: 2, away: 0 });
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0]).toContain(failure);
  });

  it('asks for a fresh snapshot when a patch does not apply', async () => {
    const { socket, score } = await withScore();

    expect(() =>
      socket().receive({
        t: 'rep.patch',
        name: NAME,
        rev: 1,
        patches: [{ op: 'remove', path: '/missing' }],
      }),
    ).not.toThrow();

    expect(score.value).toEqual({ home: 0, away: 0 });
    expect(socket().sent.filter((msg) => msg.t === 'rep.sub')).toHaveLength(2);
    socket().receive({
      t: 'rep.snap',
      epoch: 'e1',
      id: socket().last('rep.sub').id,
      name: NAME,
      rev: 1,
      value: { home: 4, away: 4 },
    });
    expect(score.value).toEqual({ home: 4, away: 4 });
  });
});
