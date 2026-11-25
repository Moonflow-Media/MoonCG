import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isLoopbackRegistryUrl, MoonCGError } from '@mooncg/core';
import { errorMessage } from '../kernel/logger.js';
import { addressProblem, download, type PrivateNetworks } from '../registry/https.js';
import { ipProblem, type Reach } from '../registry/network.js';
import {
  type InstallLimits,
  isInside,
  isNetworkPath,
  moveDir,
  realNearest,
  refuse,
  removeDir,
  storageError,
  storageProblem,
} from './files.js';
import {
  fetchGit,
  type GitOptions,
  gitHostOf,
  gitRefProblem,
  gitUrlProblem,
  withoutCredentials,
} from './git.js';
import { copyLocalPath } from './local.js';
import type { BundleSource, FetchableSource } from './sources.js';
import { bundleRoot, extractZip } from './zip.js';

/**
 * What bundles and modules are fetched from: what the server can reach, or an archive sent to
 * it. Both are fetched the same way and with the same checks; only where they go differs.
 */
export type StageSource =
  | FetchableSource
  | {
      readonly type: 'upload';
      readonly body: NodeJS.ReadableStream;
      /** What the request said the archive is long. What arrives is counted either way. */
      readonly length?: number | undefined;
      readonly filename?: string | undefined;
    };

/** What fetching needs to know, the same for a bundle and a module. */
export interface FetchContext {
  readonly limits: InstallLimits;
  /** How long Git may take. */
  readonly timeoutMs: number;
  /** Ends Git when the server shuts down. */
  readonly signal: AbortSignal;
  readonly git?: Pick<GitOptions, 'allowFileUrls' | 'command' | 'env' | 'resolve'> | undefined;
  /** The private networks the configuration of the server allows sources on. */
  readonly privateNetworks?: PrivateNetworks | undefined;
  /** Folders of the server nothing may be copied or unpacked from. */
  readonly forbidden: readonly string[];
  /** What is fetched, for messages: `bundle` or `module`. */
  readonly noun: string;
}

/**
 * Where a source may lead: this machine only through an index on this machine, never by an
 * address of its own; a private network where the configuration allows it.
 */
function reachOf(index: unknown, access: PrivateNetworks | undefined): Reach {
  return {
    loopback: typeof index === 'string' && isLoopbackRegistryUrl(index),
    private: access,
  };
}

/** Why a request names no source to fetch from, checked before anything is created. */
export function sourceProblem(
  source: StageSource,
  noun: string,
  allowFileUrls = false,
  access?: PrivateNetworks,
): string | undefined {
  const given: Partial<Record<string, unknown>> = source ?? {};
  if (given.type === 'git') {
    const commit = given.commit;
    if (commit !== undefined && (typeof commit !== 'string' || !COMMIT.test(commit))) {
      return 'The commit must be a full commit hash';
    }
    const problem = gitUrlProblem(given.url, allowFileUrls) ?? gitRefProblem(given.ref);
    if (problem !== undefined) return problem;
    // An IP address written in it is checked now; a name when it is fetched.
    const host = gitHostOf(given.url as string)?.host ?? '';
    return ipProblem(host, reachOf(given.index, access));
  }
  if (given.type === 'url') {
    if (typeof given.url !== 'string') return `The address of the ${noun} archive is missing`;
    const problem = addressProblem(given.url, reachOf(given.index, access));
    if (problem !== undefined) return problem;
    return typeof given.sha256 === 'string' && SHA256.test(given.sha256)
      ? undefined
      : 'An archive from an address needs the SHA-256 it must have, in lowercase hex';
  }
  if (given.type === 'path' || given.type === 'zip') {
    if (typeof given.path !== 'string' || !isAbsolute(given.path)) {
      return `The path of the ${noun} must be an absolute path on the server`;
    }
    return isNetworkPath(given.path)
      ? `A network path is not accepted as the source of a ${noun}; copy it to a local disk`
      : undefined;
  }
  if (given.type === 'upload') return undefined;
  return `The source must be a Git repository, a path on the server or a ZIP archive`;
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Writes an uploaded archive to `file`, counting what arrives against the limit. */
export async function receiveUpload(
  body: NodeJS.ReadableStream,
  file: string,
  options: { readonly maxBytes: number; readonly idleMs: number; readonly declared?: number },
): Promise<void> {
  const max = options.maxBytes;
  const tooLarge = () => refuse(`The archive is larger than ${max} bytes`);
  if (options.declared !== undefined && options.declared > max) throw tooLarge();
  let received = 0;
  // An upload that stops sending holds a folder in staging; it is not waited for forever.
  const stalled = refuse('The upload stalled and was given up');
  let idle: ReturnType<typeof setTimeout> | undefined;
  const counting = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      idle?.refresh();
      done(received > max ? tooLarge() : null, chunk);
    },
  });
  idle = setTimeout(() => counting.destroy(stalled), options.idleMs);
  try {
    await pipeline(body, counting, createWriteStream(file, { flags: 'wx' }));
  } catch (error) {
    if (error instanceof MoonCGError) throw error;
    const storage = storageProblem(error);
    if (storage !== undefined) throw storageError(storage);
    throw refuse(`The upload did not arrive whole: ${errorMessage(error)}`);
  } finally {
    clearTimeout(idle);
  }
}

/**
 * Brings the files of a bundle or module into `content` and says where they came from. An
 * upload must have been received into `<dir>/upload.zip` before.
 */
export async function fetchSource(
  source: StageSource,
  dir: string,
  content: string,
  context: FetchContext,
): Promise<BundleSource> {
  const { limits } = context;
  const unpack = async (archive: string) => {
    const unpacked = join(dir, 'unpacked');
    await mkdir(unpacked);
    await extractZip(archive, unpacked, limits);
    await moveDir(await bundleRoot(unpacked), content);
    await removeDir(unpacked);
  };
  if (source.type === 'git') {
    const { url, ref } = source;
    const { commit } = await fetchGit({ url, ref }, content, {
      timeoutMs: context.timeoutMs,
      signal: context.signal,
      // While it is fetched the folder holds the history too; twice the bundle is room.
      maxBytes: limits.maxUnpackedBytes * 2,
      reach: reachOf(source.index, context.privateNetworks),
      ...context.git,
    });
    // A ref that was pinned to a commit and points elsewhere now is not what was offered.
    if (source.commit !== undefined && commit !== source.commit) {
      await removeDir(content);
      throw refuse(
        `${withoutCredentials(url)} at ${ref ?? 'HEAD'} is commit ${commit}, not ${source.commit} as the index says; nothing was kept`,
      );
    }
    return { type: 'git', url, ...(ref === undefined ? {} : { ref }), commit };
  }
  if (source.type === 'url') {
    const { url, sha256, index } = source;
    const archive = join(dir, 'download.zip');
    const got = await download(url, archive, {
      timeoutMs: context.timeoutMs,
      maxBytes: limits.maxArchiveBytes,
      signal: context.signal,
      index,
      private: context.privateNetworks,
    });
    // Checked before a single entry is read: an archive that is not the one offered is not
    // opened at all.
    if (got.sha256 !== sha256) {
      await removeDir(archive);
      throw refuse(
        `The checksum of the archive from ${withoutCredentials(url)} does not match: it is ${got.sha256}, not ${sha256}. Nothing was unpacked`,
      );
    }
    await unpack(archive);
    await removeDir(archive);
    return { type: 'url', url, sha256 };
  }
  if (source.type === 'upload') {
    const archive = join(dir, 'upload.zip');
    await unpack(archive);
    await removeDir(archive);
    // The name is shown and logged: only what a file name looks like is kept of it.
    const filename = source.filename
      ?.replace(/^.*[\\/]/, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .slice(0, 100);
    return { type: 'upload', ...(filename ? { filename } : {}) };
  }
  const { path } = source;
  const stats = await stat(path).catch(() => undefined);
  if (source.type === 'path') {
    if (stats?.isFile()) {
      throw refuse(
        'The path is a file, not a folder. Give an archive as { "type": "zip", "path": … }, or upload it',
      );
    }
    await copyLocalPath(path, content, { forbidden: [...context.forbidden], limits });
    return { type: 'path', path };
  }
  if (!stats?.isFile()) throw refuse('There is no archive at the path given');
  if (stats.size > limits.maxArchiveBytes) {
    throw refuse(`The archive is larger than ${limits.maxArchiveBytes} bytes`);
  }
  const real = await realNearest(path);
  for (const folder of context.forbidden) {
    if (isInside(await realNearest(folder), real)) {
      throw refuse(
        `The path is inside the ${context.noun}s folder or the data folder of the server`,
      );
    }
  }
  await unpack(path);
  return { type: 'zip', path };
}
