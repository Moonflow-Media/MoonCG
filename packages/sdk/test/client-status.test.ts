import { PROTOCOL_VERSION } from '@mooncg/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ConnectionStatus, createClient } from '../src/client/index.js';
import { FakeSocket, setup, tick } from './fake-socket.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A client whose changes of status are written down. */
function followed() {
  const context = setup();
  const seen: ConnectionStatus[] = [];
  const stop = context.client.onStatusChange((status) => seen.push(status));
  return { ...context, seen, stop };
}

describe('the status of the connection', () => {
  it('is reconnecting until the handshake is done, then live', () => {
    const { client, socket, seen } = followed();
    expect(client.status).toBe('reconnecting');

    socket().open();
    expect(client.status).toBe('reconnecting');

    socket().receive({ t: 'welcome', v: PROTOCOL_VERSION });
    expect(client.status).toBe('live');
    expect(seen).toEqual(['live']);
  });

  it('is reconnecting while the socket is down and live again after the next handshake', async () => {
    const { client, socket, sockets, seen } = followed();
    socket().welcome();

    socket().close();
    expect(client.status).toBe('reconnecting');
    await tick();
    expect(sockets).toHaveLength(2);
    socket().welcome();

    expect(client.status).toBe('live');
    expect(seen).toEqual(['live', 'reconnecting', 'live']);
  });

  it('tells nobody when an attempt to connect again fails: nothing changed', async () => {
    const { socket, sockets, seen } = followed();
    socket().welcome();
    socket().close();
    await tick();

    socket().close();
    await tick();

    expect(sockets).toHaveLength(3);
    expect(seen).toEqual(['live', 'reconnecting']);
  });

  it('is offline once the client is closed, and stays that', async () => {
    const { client, socket, sockets, seen } = followed();
    socket().welcome();

    client.close();
    await tick();

    expect(client.status).toBe('offline');
    expect(seen).toEqual(['live', 'offline']);
    expect(sockets).toHaveLength(1);
  });

  it('is offline when the server refuses the handshake', () => {
    const { client, socket, seen } = followed();
    socket().open();
    socket().receive({ t: 'err', code: 'forbidden', message: 'Missing permission' });

    expect(client.status).toBe('offline');
    expect(seen).toEqual(['offline']);
  });

  it('is reconnecting, not offline, for a graphic that waits for its place', () => {
    const sockets: FakeSocket[] = [];
    const client = createClient({
      bundle: 'scoreboard',
      graphic: 'graphics/overlay.html',
      url: 'ws://test/ws',
      onDuplicate: () => {},
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    sockets[0]?.open();
    sockets[0]?.receive({ t: 'err', code: 'conflict', message: 'Already open' });

    expect(client.status).toBe('reconnecting');
    client.close();
  });

  it('is offline when the server ends the page as the instance of its graphic', () => {
    const { client, socket, seen } = followed();
    socket().welcome();

    socket().receive({ t: 'graphic.end', reason: 'disconnected' });

    expect(client.status).toBe('offline');
    expect(seen).toEqual(['live', 'offline']);
  });

  it('stops telling a listener that was taken away', () => {
    const { socket, seen, stop } = followed();
    stop();
    socket().welcome();
    expect(seen).toEqual([]);
  });

  it('tells the other listeners when one of them throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, socket } = setup();
    const seen: ConnectionStatus[] = [];
    client.onStatusChange(() => {
      throw new Error('listener broke');
    });
    client.onStatusChange((status) => seen.push(status));

    socket().welcome();

    expect(seen).toEqual(['live']);
    expect(error).toHaveBeenCalledOnce();
  });
});
