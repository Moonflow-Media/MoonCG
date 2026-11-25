import { describe, expect, it } from 'vitest';
import { addressProblem, getJson, indexUrlProblem } from '../src/registry/https.js';
import {
  ipProblem,
  plainHttpAllowed,
  privateEntryProblem,
  privateNetworks,
  resolveChecked,
} from '../src/registry/network.js';

/**
 * Indexes and sources on a private network: closed unless the configuration of the server
 * names the hosts or networks (`registryAllowPrivate`), and plain `http://` for them only
 * with a second setting (`registryAllowPrivateHttp`).
 */

const OPTIONS = { timeoutMs: 300, maxBytes: 1024 };
const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('registryAllowPrivate entries', () => {
  it.each([
    '10.0.0.0/8',
    '10.1.2.0/24',
    '10.1.2.3',
    '172.16.0.0/12',
    '192.168.10.0/24',
    '100.64.0.0/10',
    'fd00::/8',
    'fd12:3456::1',
    'git.corp.example',
    'Index.Intranet',
    'intranet',
  ])('takes %s', (entry) => {
    expect(privateEntryProblem(entry)).toBeUndefined();
  });

  it.each([
    // Not private: the internet, or broader than a private network.
    '8.8.8.0/24',
    '0.0.0.0/0',
    '10.0.0.0/7',
    '::/0',
    // Never opened: this machine, link-local (cloud metadata), multicast, reserved.
    '127.0.0.0/8',
    '127.0.0.1',
    '::1',
    '169.254.169.254',
    'fe80::/10',
    '224.0.0.1',
    'localhost',
    'a.localhost',
    // No host, address or network.
    'https://git.corp.example',
    'git.corp.example:443',
    '*.corp.example',
    '10.0.0.0/33',
    '10.0.0.0/x',
    '',
  ])('refuses %j', (entry) => {
    expect(privateEntryProblem(entry)).toBeDefined();
    expect(() => privateNetworks([entry], false)).toThrow();
  });
});

describe('addresses on a private network', () => {
  const access = privateNetworks(['10.20.0.0/16', 'git.corp.example', 'fd00::/8'], false);
  const withHttp = privateNetworks(['10.20.0.0/16', 'git.corp.example'], true);

  it('stay closed without the setting', () => {
    expect(addressProblem('https://10.20.1.1/i.json', { loopback: false })).toMatch(/private/);
    expect(addressProblem('https://[fd00::1]/i.json', { loopback: false })).toMatch(/private/);
  });

  it('are taken over https for allowed networks only', () => {
    const reach = { loopback: false, private: access };
    expect(addressProblem('https://10.20.1.1/i.json', reach)).toBeUndefined();
    expect(addressProblem('https://[fd00::1]/i.json', reach)).toBeUndefined();
    expect(addressProblem('https://10.21.1.1/i.json', reach)).toMatch(/private/);
    expect(addressProblem('https://192.168.1.1/i.json', reach)).toMatch(/private/);
    // Not opened by any setting.
    expect(addressProblem('https://169.254.169.254/', reach)).toMatch(/internal/);
    expect(addressProblem('https://127.0.0.1/i.json', reach)).toMatch(/this machine/);
  });

  it('take plain http only with the second setting, and only for what is allowed', () => {
    expect(addressProblem('http://10.20.1.1/i.json', { loopback: false, private: access })).toMatch(
      /https/,
    );
    const reach = { loopback: false, private: withHttp };
    expect(addressProblem('http://10.20.1.1/i.json', reach)).toBeUndefined();
    expect(addressProblem('http://git.corp.example/i.json', reach)).toBeUndefined();
    expect(addressProblem('http://10.21.1.1/i.json', reach)).toMatch(/https/);
    expect(addressProblem('http://example.org/i.json', reach)).toMatch(/https/);
    expect(plainHttpAllowed('git.corp.example', withHttp)).toBe(true);
    expect(plainHttpAllowed('git.corp.example', access)).toBe(false);
  });

  it('decide whether an index address is usable', () => {
    expect(indexUrlProblem('http://git.corp.example/i.json')).toMatch(/https/);
    expect(indexUrlProblem('http://git.corp.example/i.json', access)).toMatch(/https/);
    expect(indexUrlProblem('http://git.corp.example/i.json', withHttp)).toBeUndefined();
    expect(indexUrlProblem('https://git.corp.example/i.json')).toBeUndefined();
  });

  it('are checked by what a name resolves to when the server connects', async () => {
    const reach = { loopback: false, private: access };
    // An allowed name: its private addresses are taken.
    await expect(
      resolveChecked('git.corp.example', reach, { resolve: resolvesTo('10.99.0.5') }),
    ).resolves.toEqual([{ address: '10.99.0.5', family: 4 }]);
    // An allowed network, by any name.
    await expect(
      resolveChecked('other.example', reach, { resolve: resolvesTo('10.20.3.4') }),
    ).resolves.toHaveLength(1);
    // Neither: refused.
    await expect(
      resolveChecked('other.example', reach, { resolve: resolvesTo('10.99.0.5') }),
    ).rejects.toThrow(/10\.99\.0\.5/);
    // An allowed name never opens what no setting opens.
    await expect(
      resolveChecked('git.corp.example', reach, { resolve: resolvesTo('169.254.169.254') }),
    ).rejects.toThrow(/internal/);
    await expect(
      resolveChecked('git.corp.example', reach, { resolve: resolvesTo('127.0.0.1') }),
    ).rejects.toThrow(/this machine/);
  });

  it('send plain http to an allowed private address only, never to the internet', async () => {
    const reach = { loopback: false, private: withHttp };
    await expect(
      resolveChecked('git.corp.example', reach, { plain: true, resolve: resolvesTo('10.1.1.1') }),
    ).resolves.toHaveLength(1);
    await expect(
      resolveChecked('git.corp.example', reach, {
        plain: true,
        resolve: resolvesTo('93.184.215.14'),
      }),
    ).rejects.toThrow(/plain http/);
  });

  it('let a request through the guard to an allowed private address', async () => {
    // Nothing answers there: the request fails by the network, not by the guard.
    const error = await getJson('https://git.corp.example/i.json', {
      ...OPTIONS,
      private: access,
      resolve: resolvesTo('10.255.255.1'),
    }).catch((caught: Error) => caught);
    expect(String(error)).toMatch(/did not answer|could not be reached/);
    expect(String(error)).not.toMatch(/private|internal/);
    const refused = await getJson('https://git.corp.example/i.json', {
      ...OPTIONS,
      resolve: resolvesTo('10.255.255.1'),
    }).catch((caught: Error) => caught);
    expect(String(refused)).toMatch(/internal/);
  });
});

describe('IPv6 addresses that carry an IPv4 address', () => {
  const closed = { loopback: false };

  it.each([
    // NAT64 (RFC 6052): the translator connects to the IPv4 address in the last 32 bits.
    ['64:ff9b::a00:1', /10\.0\.0\.1/],
    ['64:ff9b::10.1.2.3', /10\.1\.2\.3/],
    ['64:ff9b::a9fe:a9fe', /169\.254\.169\.254/],
    ['64:ff9b::7f00:1', /127\.0\.0\.1/],
    // Local-use NAT64 (RFC 8215), whose layout each network chooses, and 6to4 (RFC 3056).
    ['64:ff9b:1::a00:1', /internal/],
    ['64:ff9b:1:ffff::1', /internal/],
    ['2002:a00:1::1', /internal/],
    ['2002:808:808::1', /internal/],
  ])('refuses %s', (ip, reason) => {
    expect(ipProblem(ip, closed)).toMatch(reason);
  });

  it('takes the well-known NAT64 prefix for an address on the internet', () => {
    // On an IPv6-only network every IPv4 host is reached this way (DNS64).
    expect(ipProblem('64:ff9b::808:808', closed)).toBeUndefined();
    expect(ipProblem('64:ff9b::93.184.215.14', closed)).toBeUndefined();
  });

  it('takes NAT64 to a private address the configuration allows', () => {
    const access = privateNetworks(['10.8.0.0/16'], false);
    expect(ipProblem('64:ff9b::a08:2', { loopback: false, private: access })).toBeUndefined();
    expect(ipProblem('64:ff9b::a09:2', { loopback: false, private: access })).toMatch(
      /10\.9\.0\.2/,
    );
  });
});
