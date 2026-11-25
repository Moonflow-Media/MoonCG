// Shared by the login and the setup page: sends the form as JSON to the URL in `data-action`
// and goes to `data-then` when the server accepts it.

const form = document.getElementById('form');
const notice = document.getElementById('notice');

// The setup URL the server prints carries the code. It is taken into the form and removed
// from the address bar, so it does not stay in the browser's history.
const code = new URLSearchParams(location.search).get('code');
if (code !== null && form.elements.code) {
  form.elements.code.value = code;
  history.replaceState(null, '', location.pathname);
}

// Signing in with an external account ends here when it did not work, with the reason as a
// code in the address. Only the messages below are ever shown: nothing of the address itself
// is put on the page. The code is then removed from the address bar.
const FAILED = {
  state:
    'Signing in did not finish: it took too long, or it was started in another browser. Try again.',
  provider: 'The provider did not confirm who you are. Try again.',
  not_linked:
    'This account is not linked to a user here. Ask an administrator to link it on the Users page.',
  realm:
    'This account was linked while the provider was set up differently. Ask an administrator to link it again on the Users page.',
  disabled: 'This user may not sign in.',
  setup: 'This installation has no user yet. Set it up first.',
  address:
    'Signing in with an external account is not possible at this address. Open MoonCG at its public address.',
};
const failed = new URLSearchParams(location.search).get('error');
if (failed !== null) {
  if (Object.hasOwn(FAILED, failed)) notice.textContent = FAILED[failed];
  history.replaceState(null, '', location.pathname);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  notice.textContent = '';
  const fields = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch(form.dataset.action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (response.ok) {
      location.assign(form.dataset.then);
      return;
    }
    const { error } = await response.json();
    notice.textContent = error.message;
  } catch (error) {
    notice.textContent = `The server could not be reached: ${error.message}`;
  }
});
