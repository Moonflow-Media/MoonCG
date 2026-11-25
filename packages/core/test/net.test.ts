import { describe, expect, it } from 'vitest';
import { parseManifest } from '../src/manifest/manifest.js';
import {
  isLoopbackAddress,
  isLoopbackAuthority,
  isLoopbackHost,
  isLoopbackOrigin,
} from '../src/net.js';

describe('isLoopbackOrigin', () => {
  it.each([
    'http://localhost',
    'http://localhost:5173',
    'https://LOCALHOST:8443',
    'http://127.0.0.1:9090',
    'http://127.3.2.1',
    'http://[::1]:3000',
  ])('accepts %s', (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(true);
  });

  it.each([
    '',
    'null',
    'localhost:5173',
    'https://evil.example',
    'http://localhost.evil.example',
    'http://evil.localhost',
    'http://127.0.0.1.nip.io',
    'http://192.168.1.10:5173',
    'http://0.0.0.0:9090',
    'http://localhost:5173, https://evil.example',
    'file:///C:/page.html',
    'ws://localhost:9090',
  ])('refuses "%s"', (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(false);
  });

  it('refuses a missing origin: whether none is fine is for the caller to say', () => {
    expect(isLoopbackOrigin(undefined)).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.8.9.255', '::1', '[::1]'])(
    'accepts %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    '',
    '0.0.0.0',
    '::',
    '192.168.1.5',
    '127.0.0.1.example.com',
    'localhost.example.com',
    'evil.localhost',
    '127.0.0.256',
    '127.1',
    '1127.0.0.1',
    'localhost:9090',
    '::ffff:127.0.0.1',
  ])('refuses %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('isLoopbackAuthority', () => {
  it.each(['localhost', 'localhost:9090', '127.0.0.1:9090', '[::1]:9090', '[::1]', 'LocalHost:1'])(
    'accepts the Host header %s',
    (host) => {
      expect(isLoopbackAuthority(host)).toBe(true);
    },
  );

  it.each([
    undefined,
    '',
    'example.com',
    'example.com:9090',
    'localhost.example.com:9090',
    '127.0.0.1.nip.io',
    'localhost:',
    'localhost:99999999',
    'localhost:9090/x',
    'user@localhost',
    'localhost, example.com',
    '::1',
  ])('refuses the Host header %s', (host) => {
    expect(isLoopbackAuthority(host)).toBe(false);
  });
});

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.9'])(
    'accepts the socket address %s',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  it.each([undefined, '', '10.0.0.1', '::ffff:10.0.0.1', 'localhost', '::', '0.0.0.0'])(
    'refuses the socket address %s',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(false);
    },
  );
});

describe('dev.url in a manifest', () => {
  const manifest = (url: unknown) =>
    parseManifest({ manifest: 1, kind: 'bundle', name: 'demo', version: '1.0.0', dev: { url } });

  it.each([
    'http://localhost:5173',
    'https://localhost:5173/',
    'http://127.0.0.1:5173/base/',
    'http://[::1]:5173',
  ])('accepts %s', (url) => {
    expect(manifest(url)).toMatchObject({ ok: true, manifest: { dev: { url } } });
  });

  it.each([
    'http://example.com:5173',
    'http://192.168.1.10:5173',
    'http://localhost.example.com',
    'ftp://localhost/',
    'file:///C:/bundle/index.html',
    'javascript:alert(1)',
    'http://user:secret@localhost:5173',
    'http://localhost:5173/?next=http://example.com',
    'http://localhost:5173/#x',
    'localhost:5173',
    '//localhost:5173',
    5173,
  ])('refuses %s', (url) => {
    const result = manifest(url);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.map((error) => error.path)).toContain('dev.url');
  });
});
