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
