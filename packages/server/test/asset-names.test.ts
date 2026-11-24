import { describe, expect, it } from 'vitest';
import { accepts, assetFileName, assetType } from '../src/assets/names.js';

describe('assetFileName', () => {
  it.each([
    ['logo.png', 'logo.png'],
    ['Team Logo (1).png', 'Team Logo (1).png'],
    ['größe-één.svg', 'größe-één.svg'],
    // Composed and decomposed spellings of a name are one file.
    ['e\u0301.png', '\u00e9.png'],
  ])('keeps the ordinary name %j', (given, kept) => {
    expect(assetFileName(given)).toBe(kept);
  });

  it.each([
    ['a<b>c:d"e|f?g*h.png', 'a_b_c_d_e_f_g_h.png'],
    ['tab\tand\nline.png', 'tab_and_line.png'],
    ['logo.png:stream', 'logo.png_stream'],
  ])('replaces what no file system takes in %j', (given, cleaned) => {
    expect(assetFileName(given)).toBe(cleaned);
  });

  it.each([
    ['logo.png.', 'logo.png'],
    ['logo.png . .', 'logo.png'],
    ['  logo.png  ', 'logo.png'],
    ['.htaccess', 'htaccess'],
    ['...hidden.png', 'hidden.png'],
  ])('takes dots and spaces off the ends of %j', (given, cleaned) => {
    expect(assetFileName(given)).toBe(cleaned);
  });

  it.each([
    ['CON', '_CON'],
    ['con.png', '_con.png'],
    ['NUL.txt', '_NUL.txt'],
    ['nul', '_nul'],
    ['PRN.tar.gz', '_PRN.tar.gz'],
    ['aux.png', '_aux.png'],
    ['COM1.png', '_COM1.png'],
    ['lpt9', '_lpt9'],
    ['CON .png', '_CON .png'],
    ['COM\u00b9.png', '_COM\u00b9.png'],
  ])('keeps %j from being a device name of Windows', (given, cleaned) => {
    expect(assetFileName(given)).toBe(cleaned);
  });

  it.each([['CONSOLE.png'], ['COM10.png'], ['nullable.json'], ['icon.png']])(
    'leaves %j alone, which only looks like one',
    (given) => {
      expect(assetFileName(given)).toBe(given);
    },
  );

  it.each([
    ['../secret.png'],
    ['..\\secret.png'],
    ['a/b.png'],
    ['a\\b.png'],
    ['/etc/passwd'],
    ['C:\\Windows\\win.ini'],
    ['nul\0.png'],
    ['..'],
    ['.'],
    [''],
    ['   '],
    ['. . .'],
    [`${'a'.repeat(200)}.png`],
    // The short names Windows makes up for long ones, which can name another file.
    ['PROGRA~1'],
    ['LONGFI~1.PNG'],
    ['logo~2.png'],
  ])('refuses %j, which is no name of one file', (given) => {
    expect(assetFileName(given)).toBeUndefined();
  });

  it('takes a tilde that is no short name of Windows', () => {
    expect(assetFileName('home~away.png')).toBe('home~away.png');
    expect(assetFileName('~draft.png')).toBe('~draft.png');
  });

  it('gives back a name it has cleaned unchanged', () => {
    for (const given of ['a<b>.png', 'CON', 'logo.png. .', '.htaccess']) {
      const cleaned = assetFileName(given) as string;
      expect(assetFileName(cleaned)).toBe(cleaned);
    }
  });
});

describe('assetType', () => {
  it('knows images, fonts, sound and video by their extension, whatever its case', () => {
    expect(assetType('logo.PNG')).toEqual({ type: 'image/png', inline: true });
    expect(assetType('clip.webm')).toEqual({ type: 'video/webm', inline: true });
    expect(assetType('teams.json')).toEqual({
      type: 'application/json; charset=utf-8',
      inline: true,
    });
  });

  it('never calls a file a page, a script or a style sheet', () => {
    for (const name of ['page.html', 'page.HTM', 'x.xhtml', 'x.xml', 'x.js', 'x.mjs', 'x.css']) {
      expect(assetType(name)).toEqual({ type: 'application/octet-stream', inline: false });
    }
    expect(assetType('no-extension')).toEqual({ type: 'application/octet-stream', inline: false });
    expect(assetType('paper.pdf')).toEqual({ type: 'application/octet-stream', inline: false });
  });

  it('serves an SVG as the image it is', () => {
    expect(assetType('logo.svg')).toEqual({ type: 'image/svg+xml', inline: true });
  });
});

describe('accepts', () => {
  it('takes any file when the category says nothing', () => {
    expect(accepts(undefined, 'anything.xyz')).toBe(true);
  });

  it('takes any file when the category says so with */*', () => {
    expect(accepts(['*/*'], 'anything.xyz')).toBe(true);
    expect(accepts(['image/png', '*/*'], 'no-extension')).toBe(true);
  });

  it('matches extensions without regard to case', () => {
    expect(accepts(['.png', '.JPG'], 'logo.PNG')).toBe(true);
    expect(accepts(['.png', '.JPG'], 'photo.jpg')).toBe(true);
    expect(accepts(['.png'], 'logo.svg')).toBe(false);
    expect(accepts(['.png'], 'png')).toBe(false);
  });

  it('matches media types by what the extension stands for, never by what the upload says', () => {
    expect(accepts(['image/*'], 'logo.svg')).toBe(true);
    expect(accepts(['image/png'], 'logo.png')).toBe(true);
    expect(accepts(['image/png'], 'logo.gif')).toBe(false);
    expect(accepts(['image/*'], 'page.html')).toBe(false);
    expect(accepts(['image/*'], 'image')).toBe(false);
    expect(accepts(['application/json'], 'teams.json')).toBe(true);
  });
});
