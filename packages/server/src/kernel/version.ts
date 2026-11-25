import { readFileSync } from 'node:fs';

/** The version of this MoonCG, from the server package. Bundles name the ones they run on. */
export const MOONCG_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
