import { crc32, deflateRawSync } from 'node:zlib';

/** One entry of an archive built by `makeZip`. Everything beyond `name` is optional. */
export interface ZipItem {
  /** The name as it is written into the archive, unchecked: tests craft hostile ones. */
  readonly name: string;
  readonly data?: string | Buffer;
  /** Store the data as it is instead of compressing it. */
  readonly store?: boolean;
  /** The Unix mode, written as an archive made on Unix does. `0o120777` is a symbolic link. */
  readonly mode?: number;
  /** The uncompressed size the headers claim, where it is to differ from the truth. */
  readonly claimedSize?: number;
  /** Marks the entry as encrypted. */
  readonly encrypted?: boolean;
}

/**
 * Builds a ZIP archive in memory, byte by byte, without any check. A ZIP library refuses to
 * write the archives the server must refuse to read; this writes them.
 */
export function makeZip(items: readonly ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8');
    const data = Buffer.from(item.data ?? '');
    const stored = item.store === true || data.length === 0;
    const body = stored ? data : deflateRawSync(data);
    const size = item.claimedSize ?? data.length;
    // Bit 11: the name is UTF-8. Bit 0: encrypted.
    const flags = 0x0800 | (item.encrypted ? 1 : 0);
    const method = stored ? 0 : 8;
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // Made by: Unix (3) when a mode is given, else MS-DOS (0).
    central.writeUInt16LE(item.mode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(item.mode === undefined ? 0 : (item.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** An archive of a bundle: `files` by path, each compressed. */
export function zipOf(files: Readonly<Record<string, string | object>>): Buffer {
  return makeZip(
    Object.entries(files).map(([name, content]) => ({
      name,
      data: typeof content === 'string' ? content : JSON.stringify(content),
    })),
  );
}
