import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Where the server may connect to when it fetches for the registry and the installers: the
 * rules for IP addresses, and the resolver that applies them to every address a name
 * resolves to. Used by `https.ts` for indexes and archives and by `git.ts` for repositories.
 */

/** What a name resolves to, as `dns.lookup` with `all: true` says it. */
export type Resolver = (
  hostname: string,
  family: number,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

/**
 * Addresses the server never connects to unless told otherwise: networks that are not the
 * internet (private, shared, link-local, unique-local), and addresses that are no single
 * machine (unspecified, multicast, broadcast, reserved). An index on the internet must not
 * make the server ask what only the server can reach. IPv4-mapped IPv6 addresses are
 * checked as the IPv4 address they map.
 */
const INTERNAL = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  INTERNAL.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  // IPv4-compatible addresses, long deprecated: none is used on purpose.
  ['::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  // Local-use NAT64 (RFC 8215): each network lays out the IPv4 address in it as it likes.
  ['64:ff9b:1::', 48],
  // 6to4 (RFC 3056): the IPv4 address of a relay or of a host behind it, long deprecated.
  ['2002::', 16],
] as const) {
  INTERNAL.addSubnet(network, prefix, 'ipv6');
}
/**
 * The well-known NAT64 prefix (RFC 6052): a translator connects to the IPv4 address in the
 * last 32 bits. On an IPv6-only network every IPv4 host is reached this way, so the prefix is
 * not closed as a whole: the address is checked as the IPv4 address it carries.
 */
const NAT64 = new BlockList();
NAT64.addSubnet('64:ff9b::', 96, 'ipv6');

/** The IPv4 address in the last 32 bits of an IPv6 address. */
function lastIpv4(ip: string): string {
  const text = ip.replace(/%.*$/, '');
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)?.[1];
  if (dotted !== undefined) return dotted;
  const [head = '', tail] = text.split('::');
  const words = [
    ...(head === '' ? [] : head.split(':')),
    ...(tail === undefined || tail === '' ? [] : tail.split(':')),
  ];
  const [high = 0, low = 0] = words.slice(-2).map((word) => Number.parseInt(word, 16));
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/**
 * The networks a configuration can open: private (RFC 1918), shared (RFC 6598) and
 * unique-local IPv6. Link-local addresses (where cloud metadata services answer), multicast,
 * reserved addresses and this machine stay closed whatever is configured.
 */
const OPENABLE: readonly (readonly [string, number, 'ipv4' | 'ipv6'])[] = [
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
];
const PRIVATE = new BlockList();
for (const [network, prefix, type] of OPENABLE) PRIVATE.addSubnet(network, prefix, type);

/**
 * Hosts and networks of a private network the administrator allowed in the configuration of
 * the server (`registryAllowPrivate`), and whether plain `http://` may be used for them
 * (`registryAllowPrivateHttp`). Never set through the API: it widens what the server reaches.
 */
export interface PrivateNetworks {
  /** Host names, lowercase, whose private addresses may be asked. */
  readonly hosts: readonly string[];
  /** The allowed networks and single addresses. */
  readonly networks: BlockList;
  /** Whether plain `http://` may be used for the allowed hosts and networks. */
  readonly http: boolean;
}

const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** An entry of `registryAllowPrivate` as it is read: a network, an address or a host name. */
type PrivateEntry =
  | {
      readonly kind: 'network';
      readonly address: string;
      readonly prefix: number;
      readonly type: 'ipv4' | 'ipv6';
    }
  | { readonly kind: 'host'; readonly name: string };

function readEntry(given: string): PrivateEntry | string {
  const entry = given.trim().toLowerCase();
  const [address = '', bits, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family !== 0) {
    const type = family === 4 ? 'ipv4' : 'ipv6';
    const max = family === 4 ? 32 : 128;
    const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : Number.NaN;
    if (rest.length > 0 || !(prefix >= 0 && prefix <= max)) {
      return `"${given}" is no network such as 10.0.0.0/8 or fd00::/8`;
    }
    // Inside one of the networks that can be opened, whole: its first address is there and its
    // prefix is no shorter than that network's.
    const inside = OPENABLE.some(([network, length, kind]) => {
      if (kind !== type || prefix < length) return false;
      const one = new BlockList();
      one.addSubnet(network, length, kind);
      return one.check(address, type);
    });
    if (!inside) {
      return `"${given}" is not inside a private network (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, fc00::/7); this machine, link-local and other addresses cannot be allowed`;
    }
    return { kind: 'network', address, prefix, type };
  }
  if (
    bits !== undefined ||
    !HOST_NAME.test(entry) ||
    entry === 'localhost' ||
    entry.endsWith('.localhost')
  ) {
    return `"${given}" is no host name, address or network such as git.example.internal or 10.0.0.0/8`;
  }
  return { kind: 'host', name: entry };
}

/** Why an entry of `registryAllowPrivate` cannot be used, or `undefined` if it can. */
export function privateEntryProblem(entry: string): string | undefined {
  const read = readEntry(entry);
  return typeof read === 'string' ? read : undefined;
}

/** The private networks a configuration allows. Throws for an entry that cannot be used. */
export function privateNetworks(entries: readonly string[], http: boolean): PrivateNetworks {
  const hosts: string[] = [];
  const networks = new BlockList();
  for (const given of entries) {
    const read = readEntry(given);
    if (typeof read === 'string') throw new Error(read);
    if (read.kind === 'host') hosts.push(read.name);
    else networks.addSubnet(read.address, read.prefix, read.type);
  }
  return { hosts, networks, http };
}

/** How the server may connect for one request. */
export interface Reach {
  /** Whether this machine may be asked: only for an index on this machine and what it lists. */
  readonly loopback: boolean;
  /** The private networks the configuration allows, if any. */
  readonly private?: PrivateNetworks | undefined;
}

const typeOf = (ip: string) => (isIP(ip) === 4 ? 'ipv4' : 'ipv6');
const bare = (host: string) => host.replace(/^\[|\]$/g, '').toLowerCase();

/** Whether an internal address is one the configuration allows, by its network or its host. */
function allowedPrivate(ip: string, host: string, access: PrivateNetworks | undefined): boolean {
  if (access === undefined) return false;
  const type = typeOf(ip);
  if (!PRIVATE.check(ip, type)) return false;
  return access.networks.check(ip, type) || access.hosts.includes(bare(host));
}

/**
 * Whether plain `http://` may be used for a host that is not this machine: only when the
 * configuration allows it, and only for a host it allows, by its name or its address. Whether
 * that host really is on the private network is checked when the server connects.
 */
export function plainHttpAllowed(host: string, access: PrivateNetworks | undefined): boolean {
  if (access?.http !== true) return false;
  const name = bare(host);
  if (isIP(name) !== 0) return allowedPrivate(name, name, access);
  return access.hosts.includes(name);
}

/**
 * Why the server does not connect to an IP address, or `undefined` if it does. `host` is the
 * name it was reached by, for the hosts the configuration allows; `plain` says the request is
 * plain `http://` to a host that is not this machine, which only goes to an allowed private
 * address.
 */
export function ipProblem(ip: string, reach: Reach, host = ip, plain = false): string | undefined {
  const family = isIP(ip);
  if (family === 0) return undefined;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (type === 'ipv6' && NAT64.check(ip, type)) {
    const carried = lastIpv4(ip);
    const problem = ipProblem(carried, reach, host, plain);
    return problem === undefined
      ? undefined
      : `${ip} leads to ${carried} through NAT64: ${problem}`;
  }
  if (LOOPBACK.check(ip, type)) {
    return reach.loopback
      ? undefined
      : `${ip} is this machine, which only an index on this machine may point to`;
  }
  const allowed = allowedPrivate(ip, host, reach.private);
  if (INTERNAL.check(ip, type) && !allowed) {
    return `${ip} is a private, link-local or otherwise internal address, which is not asked`;
  }
  if (plain && !allowed) {
    return `${ip} is not on a private network allowed for plain http://`;
  }
  return undefined;
}

/** The error a refused address raises while the server connects. */
export class Refused extends Error {}

const system: Resolver = (hostname, family) =>
  new Promise((done, fail) => {
    dnsLookup(hostname, { all: true, family }, (error, addresses) =>
      error ? fail(error) : done(addresses),
    );
  });

/**
 * Resolves a name as the system does and refuses it, with `Refused`, when any of its addresses
 * is one the server does not ask, or when it has none.
 */
export async function resolveChecked(
  hostname: string,
  reach: Reach,
  options: {
    readonly family?: number;
    readonly plain?: boolean;
    readonly resolve?: Resolver | undefined;
  } = {},
): Promise<readonly { readonly address: string; readonly family: number }[]> {
  const addresses = await (options.resolve ?? system)(hostname, options.family ?? 0);
  if (addresses.length === 0) throw new Refused(`${hostname} has no address`);
  for (const { address } of addresses) {
    const problem = ipProblem(address, reach, hostname, options.plain);
    if (problem !== undefined) throw new Refused(`${hostname} resolves to ${problem}`);
  }
  return addresses;
}

/**
 * A `lookup` for `node:http` that refuses a name when any of its addresses is one the server
 * does not ask. As it runs when the connection is made, a name that changes what it points to
 * after it was checked (DNS rebinding) is caught too.
 */
export function guardedLookup(
  reach: Reach,
  resolve: Resolver | undefined,
  plain = false,
): LookupFunction {
  return ((hostname: string, options: { family?: unknown; all?: boolean }, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    resolveChecked(hostname, reach, { family, plain, resolve })
      .then((addresses) => {
        const [first] = addresses as [{ address: string; family: number }];
        if (options.all) callback(null, [...addresses]);
        else callback(null, first.address, first.family);
      })
      .catch((error: Error) => callback(error as NodeJS.ErrnoException, '', 0));
  }) as LookupFunction;
}
