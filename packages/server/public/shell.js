// The minimal dashboard shell: lists the bundles the signed-in user may use, embeds each
// panel in an iframe, and lets whoever may manage bundles enable, disable and reload them.
// It follows the `system:revision` replicant, which counts changes to the bundles, and asks
// for the list again when it moves. So a change of state shows up without polling.

/** Width in pixels of one dashboard grid column. A panel's manifest `width` counts columns. */
const COLUMN_WIDTH = 128;

function element(tag, properties = {}, children = []) {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
}

const container = document.getElementById('bundles');
const notice = document.getElementById('notice');

function renderPanel(panel) {
  return element('div', { className: 'panel' }, [
    element('h3', { textContent: panel.title }),
    element('iframe', {
      src: panel.url,
      title: panel.title,
      style: `width: ${panel.width * COLUMN_WIDTH}px`,
    }),
  ]);
}

function renderGraphic(graphic) {
  return element('li', {}, [
    element('a', { href: graphic.url, target: '_blank', textContent: graphic.url }),
    ` (${graphic.width}x${graphic.height})`,
  ]);
}

/** Asks the server to change a bundle's state and shows why if it refuses. */
async function change(bundle, action) {
  notice.textContent = '';
  try {
    // A request that changes something must carry JSON: see "request forgery" in the docs.
    const response = await fetch(`/api/v1/bundles/${encodeURIComponent(bundle)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (response.ok) return;
    const { error } = await response.json();
    notice.textContent = `Could not ${action} "${bundle}": ${error.message}`;
  } catch (error) {
    notice.textContent = `Could not ${action} "${bundle}": ${error.message}`;
  } finally {
    await refresh();
  }
}

function renderActions(bundle) {
  const actions = bundle.state === 'disabled' ? ['enable'] : ['reload', 'disable'];
  return element(
    'span',
    { className: 'actions' },
    actions.map((action) =>
      element('button', {
        type: 'button',
        textContent: action,
        onclick: () => change(bundle.name, action),
      }),
    ),
  );
}

function renderBundle(bundle, canManage) {
  const heading = element('h2', {}, [
    bundle.title ?? bundle.name,
    element('span', { className: 'state', textContent: bundle.state }),
    // No button that the server would refuse.
    ...(canManage ? [renderActions(bundle)] : []),
  ]);
  const section = element('section', { className: bundle.state }, [heading]);
  if (bundle.errors.length > 0) {
    section.append(
      element(
        'ul',
        { className: 'errors' },
        bundle.errors.map((error) => element('li', { textContent: error })),
      ),
    );
  }
  if (bundle.panels.length > 0) {
    section.append(element('div', { className: 'panels' }, bundle.panels.map(renderPanel)));
  }
  if (bundle.graphics.length > 0) {
    section.append(
      element('p', { textContent: 'Graphics:' }),
      element('ul', {}, bundle.graphics.map(renderGraphic)),
    );
  }
  return section;
}

/** What was rendered last, to leave the panels alone when nothing about them changed. */
let rendered = '';

async function refresh() {
  try {
    const response = await fetch('/api/v1/bundles');
    if (response.status === 401) return toLogin();
    if (!response.ok) throw new Error(`The server answered ${response.status}`);
    const text = await response.text();
    if (text === rendered) return;
    rendered = text;
    const { bundles, canManage } = JSON.parse(text);
    container.replaceChildren(...bundles.map((bundle) => renderBundle(bundle, canManage)));
    if (bundles.length === 0) container.textContent = 'There is no bundle you may use.';
  } catch (error) {
    container.textContent = `Could not load the bundles: ${error.message}`;
  }
}

function toLogin() {
  location.assign('/login');
}

/** Shows who is signed in. */
async function showUser() {
  const response = await fetch('/api/v1/me');
  if (response.status === 401) return toLogin();
  const { user, roles } = await response.json();
  document.getElementById('user').textContent = `${user.name} (${roles.join(', ') || 'no role'})`;
}

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/v1/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  toLogin();
});

await Promise.all([showUser(), refresh()]);
try {
  // The shell is no bundle: it connects under the server's own name, "system".
  const { createClient } = await import('/sdk/mooncg.js');
  createClient({ bundle: 'system' }).replicant('revision').subscribe(refresh);
} catch {
  notice.textContent = 'Live updates are off: the SDK could not be loaded. Reload to refresh.';
}
