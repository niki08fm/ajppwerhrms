import type { ErrorCode } from '@ajpwer/shared';

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || '/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode | 'NETWORK',
    message: string,
    public field: string | null = null,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export function qs(params: Query = {}): string {
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

let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
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
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (e.g. a proxy error page)
  }
  if (!res.ok) {
    const e = (json as { error?: { code: ErrorCode; message: string; field: string | null; details?: unknown } })?.error;
    if (res.status === 401 && e?.code === 'UNAUTHENTICATED' && !path.startsWith('/auth/') && !path.startsWith('/tablet') && !path.startsWith('/punches')) onUnauthenticated?.();
    throw new ApiError(res.status, e?.code ?? 'INTERNAL', e?.message ?? `The server returned ${res.status}.`, e?.field ?? null, e?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, params?: Query) => request<T>('GET', path + qs(params)),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', path, body ?? {}, headers),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Download a file endpoint (CSV/XLSX) with the session cookie. */
export async function download(path: string, fallbackName: string) {
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

export interface ListResponse<T> {
  data: T[];
  meta: { total: number; nextCursor: string | null; [k: string]: unknown };
}

export const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something unexpected happened.');
