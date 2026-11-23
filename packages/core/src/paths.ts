/**
 * True for a forward-slash path that stays inside its base directory: no empty, "." or ".."
 * segments, no backslashes and no drive letters. Used for manifest files and for URL paths.
 */
export function isSafeRelativePath(path: string): boolean {
  return path
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && !/[\\:]/.test(part));
}
