const form = document.querySelector('#archive-unlock');
const status = document.querySelector('#archive-status');
const button = form.querySelector('button');
const password = document.querySelector('#archive-password');
const encoder = new TextEncoder();
let session;

async function read(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The snapshot could not be loaded.');
  return response;
}

function waitForController() {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', ready);
      reject(new Error('The viewer could not start. Reload the page and try again.'));
    }, 10000);
    function ready() {
      if (!navigator.serviceWorker.controller) return;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', ready);
      resolve();
    }
    navigator.serviceWorker.addEventListener('controllerchange', ready);
  });
}

navigator.serviceWorker?.addEventListener('message', event => {
  if (event.data?.type === 'snapshot-session' && event.ports[0]) {
    event.ports[0].postMessage(session ?? null);
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = 'Unlocking…';
  try {
    if (!navigator.serviceWorker || !crypto.subtle) {
      throw new Error('Open this page over HTTPS in a browser with service workers enabled.');
    }
    const [header, response] = await Promise.all([
      read('./vault/header.json').then(response => response.json()), read('./vault/index.enc'),
    ]);
    const ciphertext = new Uint8Array(await response.arrayBuffer());
    const passwordKey = await crypto.subtle.importKey('raw', encoder.encode(password.value), 'PBKDF2', false, ['deriveKey']);
    password.value = '';
    const key = await crypto.subtle.deriveKey({
      name: 'PBKDF2', salt: Uint8Array.from(atob(header.salt), char => char.charCodeAt(0)),
      iterations: header.iterations, hash: 'SHA-256',
    }, passwordKey, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: ciphertext.subarray(0, 12), additionalData: encoder.encode('vault/index.enc'),
      }, key, ciphertext.subarray(12));
    } catch {
      throw new Error('Incorrect password.');
    }
    session = {key, routes: JSON.parse(new TextDecoder().decode(plaintext))};
    await navigator.serviceWorker.register('./archive-worker.js');
    await waitForController();
    document.body.removeAttribute('data-locked');
    await import('./app.js');
    document.querySelector('[data-workflow][aria-current]').focus();
  } catch (error) {
    session = undefined;
    document.body.setAttribute('data-locked', '');
    status.textContent = error.message;
    button.disabled = false;
    password.focus();
  }
});
button.disabled = false;
