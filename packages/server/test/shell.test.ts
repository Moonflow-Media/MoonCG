import { afterEach, describe, expect, it } from 'vitest';
import { startWithRoles } from './auth-helpers.js';
import { temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

describe('the shell page', () => {
  it('offers to sign out and asks the server what the user may do', async () => {
    const { http, cookies, server } = await startWithRoles(temporary);
    cleanup.push(() => server.close());
    const page = await http('GET', '/', { cookie: cookies.operator });
    const script = await http('GET', '/shell.js', { cookie: cookies.operator });
    expect(page.text).toContain('id="logout"');
    expect(page.text).toContain('id="user"');
    expect(script.text).toContain('/api/v1/auth/logout');
    expect(script.text).toContain('/api/v1/me');
    // Buttons that would be refused are not drawn: the list says whether bundles can be managed.
    expect(script.text).toContain('canManage');
    // It follows the change counter everyone may read, not the list only managers may.
    expect(script.text).toContain("replicant('revision')");
    expect(script.text).not.toContain("replicant('bundles')");
  });
});
