const scope = new URL(self.registration.scope);
const prefix = scope.pathname + 'api/';
const encoder = new TextEncoder();
const sessions = new Map();

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function failure(status, error) {
  return new Response(JSON.stringify({error}), {
    status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
  });
}

async function sessionFor(id) {
  if (!id) return null;
  if (sessions.has(id)) return sessions.get(id);
  const client = await self.clients.get(id);
  if (!client) return null;
  if (sessions.has(id)) return sessions.get(id);
  const pending = new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => finish(null), 3000);
    function finish(data) {
      clearTimeout(timer);
      channel.port1.close();
      resolve(data);
    }
    channel.port1.onmessage = event => finish(event.data);
    client.postMessage({type: 'snapshot-session'}, [channel.port2]);
  });
  sessions.set(id, pending);
  if (sessions.size > 8) sessions.delete(sessions.keys().next().value);
  const session = await pending;
  if (!session) sessions.delete(id);
  return session;
}

async function decrypt(session, filename) {
  const response = await fetch(new URL(filename, scope));
  if (!response.ok) throw new Error('Encrypted asset unavailable');
  const bytes = new Uint8Array(await response.arrayBuffer());
  return crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: encoder.encode(filename),
  }, session.key, bytes.subarray(12));
}

function byteRange(value, size) {
  if (!value) return [0, size - 1];
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end ? [start, end] : null;
}

async function serveSnapshot(event, url) {
  const {request} = event;
  if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'This snapshot is read-only.');
  const session = await sessionFor(event.clientId);
  if (!session) return failure(401, 'Unlock the snapshot to view it.');
  const route = url.pathname.slice(scope.pathname.length) + url.search;
  const asset = session.routes[route];
  if (!asset) return failure(404, 'This item is unavailable in the snapshot.');
  const [filename, type, size] = asset;
  const range = request.headers.get('Range');
  const positions = byteRange(range, size);
  const headers = new Headers({
    'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (!positions) {
    headers.set('Content-Range', 'bytes */' + size);
    return new Response(null, {status: 416, headers});
  }
  const [start, end] = positions;
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  const options = {status: range ? 206 : 200, headers};
  if (request.method === 'HEAD') return new Response(null, options);
  try {
    // A media player may issue several byte-range requests for the same clip.
    session.media ??= new Map();
    let bytes;
    if (type === 'video/mp4') {
      if (!session.media.has(filename)) {
        const pending = decrypt(session, filename).catch(error => {
          session.media.delete(filename);
          throw error;
        });
        session.media.set(filename, pending);
        if (session.media.size > 4) session.media.delete(session.media.keys().next().value);
      }
      bytes = await session.media.get(filename);
    } else {
      bytes = await decrypt(session, filename);
    }
    return new Response(new Uint8Array(bytes, start, end - start + 1), options);
  } catch {
    return failure(502, 'The encrypted asset could not be loaded.');
  }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin === scope.origin && url.pathname.startsWith(prefix)) {
    event.respondWith(serveSnapshot(event, url));
  }
});
