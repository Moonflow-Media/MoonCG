const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isLoopbackV4(text: string): boolean {
  const match = IPV4_LOOPBACK.exec(text);
  return match?.slice(1).every((part) => Number(part) <= 255) === true;
}

/**
 * Whether a host name, without a port, names this machine and nothing else: `localhost`, an
 * address in `127.0.0.0/8`, or `::1` (with or without brackets). Nothing is resolved, so a
 * name that merely points here does not count.
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  return name === 'localhost' || name === '::1' || name === '[::1]' || isLoopbackV4(name);
}

/**
 * Whether a `Host` header names this machine: a loopback host, optionally with a port. A
 * page whose name was pointed at `127.0.0.1` (DNS rebinding) still sends its own name here.
 */
export function isLoopbackAuthority(host: string | undefined): boolean {
  if (host === undefined) return false;
  const match = /^(\[[^\]]*\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(host);
  if (!match) return false;
  const [, name = '', port] = match;
  if (port !== undefined && Number(port) > 65535) return false;
  // A bare IPv6 address is no authority: it would have to be in brackets.
  return name !== '::1' && isLoopbackHost(name);
}

/** Whether the address of a socket's other end is this machine. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const text = address.toLowerCase();
  if (text === '::1') return true;
  return isLoopbackV4(text.startsWith('::ffff:') ? text.slice('::ffff:'.length) : text);
}

const ORIGIN = /^https?:\/\/(\[[^\]]*\]|[^:/?#@[\]\s,]+)(?::(\d{1,5}))?$/i;

/**
 * Whether an origin, as a browser states it in the `Origin` header, is a page served from
 * this machine: `http://` or `https://` on a loopback host, with any port and nothing
 * after it. Anything else is not, including `null`, a list of origins and no origin at all.
 * Read by hand, like the address of a development server: this package has no `URL`.
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  const match = origin === undefined ? null : ORIGIN.exec(origin);
  if (!match) return false;
  const [, host = '', port] = match;
  return isLoopbackHost(host) && (port === undefined || Number(port) <= 65535);
}
