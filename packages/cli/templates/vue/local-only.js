/**
 * Keeps what Vite hands on to MoonCG to this machine.
 *
 * In dev mode MoonCG signs every request from this machine in as the administrator. Vite's
 * proxy sends everything on from this machine, so a client of another computer would be
 * signed in too if Vite listened on the network (`vite --host`, or `server.host`). MoonCG
 * cannot tell: it sees only the connection from Vite. So the proxy answers 403 to every
 * client that is not on this machine, for requests and for WebSocket connections alike.
 */

const REFUSAL =
  'MoonCG is in dev mode, which signs in every request from this machine, so this ' +
  'development server hands nothing on to it for another computer. Keep Vite on this ' +
  'machine (without --host) while "mooncg dev" runs.';

/** Whether the address of a connection is one of this machine. */
export function fromThisMachine(address) {
  if (typeof address !== 'string') return false;
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return plain === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain);
}

/**
 * The `bypass` of each proxied path. It leaves a request of this machine to the proxy and
 * answers any other with 403 itself: `res` for a request, the socket for a WebSocket
 * connection, which Vite passes without `res`. Returning the address unchanged tells Vite
 * that the request is dealt with.
 */
export function localOnly(req, res) {
  if (fromThisMachine(req.socket?.remoteAddress)) return undefined;
  if (res) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(REFUSAL);
  } else {
    req.socket?.end(
      `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(REFUSAL)}\r\nConnection: close\r\n\r\n${REFUSAL}`,
    );
  }
  return req.url ?? '/';
}
