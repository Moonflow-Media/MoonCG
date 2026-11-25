// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, swapStylesheets } from '../src/client/index.js';
import { FakeSocket } from './fake-socket.js';

beforeAll(() => {
  // A panel of the bundle, as the server serves it.
  const { happyDOM } = window as unknown as {
    happyDOM: { setURL(url: string): void; settings: Record<string, unknown> };
  };
  happyDOM.setURL('http://127.0.0.1:9090/b/scoreboard/dashboard/control.html');
  // Nothing is served here; a stylesheet that is not fetched counts as loaded.
  happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
});

afterEach(() => {
  document.head.innerHTML = '';
});

function addLink(href: string, rel = 'stylesheet'): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = rel;
  link.href = href;
  document.head.append(link);
  return link;
}

const hrefs = () =>
  [...document.querySelectorAll('link')].map(
    (link) => new URL(link.href).pathname + new URL(link.href).search,
  );

describe('swapStylesheets', () => {
  it('replaces the matching stylesheet links with cache-busted ones and keeps the others', () => {
    addLink('/b/scoreboard/dashboard/control.css');
    addLink('/b/scoreboard/dashboard/other.css');
    addLink('/b/scoreboard/dashboard/control.css', 'icon');

    expect(swapStylesheets('scoreboard', ['dashboard/control.css'], 1234)).toBe(true);

    const links = [...document.querySelectorAll('link')];
    const swapped = links.filter((link) => link.href.includes('mooncg-css=1234'));
    expect(swapped).toHaveLength(1);
    expect(swapped[0]?.rel).toBe('stylesheet');
    expect(new URL(swapped[0]?.href ?? '').pathname).toBe('/b/scoreboard/dashboard/control.css');
    expect(hrefs()).toContain('/b/scoreboard/dashboard/other.css');
  });

  it('matches relative links and links that carry a query already', () => {
    addLink('./theme.css?v=2');
    expect(swapStylesheets('scoreboard', ['dashboard/theme.css'], 7)).toBe(true);
    expect(hrefs()).toEqual(['/b/scoreboard/dashboard/theme.css?v=2&mooncg-css=7']);
  });

  it('answers false when a changed file is not linked from the page', () => {
    addLink('/b/scoreboard/dashboard/control.css');
    expect(swapStylesheets('scoreboard', ['dashboard/imported.css'], 1)).toBe(false);
    expect(swapStylesheets('other', ['dashboard/control.css'], 1)).toBe(false);
  });

  it('answers false when a changed file is also imported by a stylesheet of the page', () => {
    const link = addLink('/b/scoreboard/dashboard/theme.css');
    addLink('/b/scoreboard/dashboard/other.css');
    // happy-dom parses no `@import`: the page's sheets are what a browser would list.
    const imported = { href: 'http://127.0.0.1:9090/b/scoreboard/dashboard/theme.css' };
    const nested = { href: 'nested.css', cssRules: [{ href: 'theme.css', styleSheet: null }] };
    const sheets = (rules: object[]) => [
      { href: 'http://127.0.0.1:9090/b/scoreboard/dashboard/main.css', cssRules: rules },
      {
        href: 'https://fonts.example/x.css',
        get cssRules(): never {
          throw new DOMException('cross-origin', 'SecurityError');
        },
      },
    ];
    const spy = vi.spyOn(document, 'styleSheets', 'get');

    spy.mockReturnValue(sheets([{ ...imported, styleSheet: null }]) as never);
    expect(swapStylesheets('scoreboard', ['dashboard/theme.css'], 1)).toBe(false);
    expect(link.href).not.toContain('mooncg-css');
    // Followed into what an imported sheet imports, relative to that sheet.
    const deep = { ...nested, href: 'http://127.0.0.1:9090/b/scoreboard/dashboard/nested.css' };
    spy.mockReturnValue(sheets([{ href: deep.href, styleSheet: deep }]) as never);
    expect(swapStylesheets('scoreboard', ['dashboard/theme.css'], 1)).toBe(false);
    // An import of another file is no reason to reload.
    expect(swapStylesheets('scoreboard', ['dashboard/other.css'], 1)).toBe(true);
    spy.mockRestore();
  });

  it('replaces the previous cache buster instead of adding another one', () => {
    addLink('/b/scoreboard/graphics/a.css');
    swapStylesheets('scoreboard', ['graphics/a.css'], 1);
    swapStylesheets('scoreboard', ['graphics/a.css'], 2);
    const stylesheets = [
      ...document.querySelectorAll('link[rel="stylesheet"]'),
    ] as HTMLLinkElement[];
    expect(stylesheets.at(-1)?.href).toMatch(/\?mooncg-css=2$/);
  });
});

describe('the css message', () => {
  function client(restyle?: (files: readonly string[]) => void) {
    const sockets: FakeSocket[] = [];
    const reloadPage = vi.fn();
    createClient({
      bundle: 'scoreboard',
      url: 'ws://test/ws',
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      reloadPage,
      ...(restyle ? { restyle } : {}),
    });
    const socket = sockets[0] as FakeSocket;
    socket.welcome();
    return { socket, reloadPage };
  }

  it('swaps the stylesheet in place when the page links it', () => {
    addLink('/b/scoreboard/dashboard/control.css');
    const { socket, reloadPage } = client();
    socket.receive({ t: 'css', files: ['dashboard/control.css'] });
    expect(reloadPage).not.toHaveBeenCalled();
    expect(document.querySelector('link')?.href).toContain('mooncg-css=');
  });

  it('reloads the page when it has no matching link', () => {
    addLink('/b/scoreboard/dashboard/control.css');
    const { socket, reloadPage } = client();
    socket.receive({ t: 'css', files: ['dashboard/other.css'] });
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('hands the files to a restyle option instead', () => {
    const restyle = vi.fn();
    const { socket, reloadPage } = client(restyle);
    socket.receive({ t: 'css', files: ['dashboard/x.css'] });
    expect(restyle).toHaveBeenCalledWith(['dashboard/x.css']);
    expect(reloadPage).not.toHaveBeenCalled();
  });
});
