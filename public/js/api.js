let csrfToken = null;

export async function fetchCsrfToken(force = false) {
  if (csrfToken && !force) return csrfToken;
  try {
    const res = await fetch('/api/csrf-token', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      csrfToken = data.csrfToken;
    }
  } catch (_) {}
  return csrfToken;
}

export function clearCsrfToken() {
  csrfToken = null;
}

async function send(method, url, data) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (csrfToken) opts.headers['X-CSRF-Token'] = csrfToken;
  if (data) opts.body = JSON.stringify(data);
  const res = await fetch(url, opts);
  let json;
  try { json = await res.json(); } catch (_) { json = {}; }
  return { res, json };
}

export async function api(method, url, data) {
  if (!csrfToken) await fetchCsrfToken();
  let { res, json } = await send(method, url, data);
  // Stale/missing CSRF token (server restarted, cookie rotated) — refresh once and retry
  if (res.status === 403 && method !== 'GET') {
    csrfToken = null;
    await fetchCsrfToken(true);
    ({ res, json } = await send(method, url, data));
  }
  if (!res.ok) {
    const err = new Error(json.error || 'API error');
    err.status = res.status;
    err.response = json;
    throw err;
  }
  return json;
}

// Authenticated headers for raw fetch calls (e.g. multipart uploads)
export async function authHeaders(extra = {}) {
  if (!csrfToken) await fetchCsrfToken();
  return { 'X-CSRF-Token': csrfToken || '', ...extra };
}
