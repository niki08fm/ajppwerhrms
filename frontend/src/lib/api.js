export const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';

export class ApiError extends Error {
  constructor(status, code, message, field = null, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
    this.name = 'ApiError';
  }
}

export function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(','));
    } else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

let onUnauthenticated = null;
export function setUnauthenticatedHandler(fn) {
  onUnauthenticated = fn;
}

async function request(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: body instanceof FormData ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check the connection and try again.');
  }
  if (res.status === 204) return undefined;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (e.g. a proxy error page)
  }
  if (!res.ok) {
    const e = json?.error;
    if (res.status === 401 && e?.code === 'UNAUTHENTICATED' && !path.startsWith('/auth/') && !path.startsWith('/tablet') && !path.startsWith('/punches')) onUnauthenticated?.();
    throw new ApiError(res.status, e?.code ?? 'INTERNAL', e?.message ?? `The server returned ${res.status}.`, e?.field ?? null, e?.details);
  }
  return json;
}

export const api = {
  get: (path, params) => request('GET', path + qs(params)),
  post: (path, body, headers) => request('POST', path, body ?? {}, headers),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

/** Download a file endpoint (CSV/XLSX) with the session cookie. */
export async function download(path, fallbackName) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  if (!res.ok) {
    let msg = `Export failed (${res.status}).`;
    try {
      msg = (await res.json()).error.message;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, 'INTERNAL', msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const errorMessage = (e) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something unexpected happened.');
