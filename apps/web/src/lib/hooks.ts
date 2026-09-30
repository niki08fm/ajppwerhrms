import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type ListResponse } from './api';

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

const RESERVED = new Set(['q', 'sort', 'limit', 'tab', 'view']);

/**
 * The list contract, client side. Filter state lives in the URL
 * (?dept=…&status=ACTIVE&q=kumar&sort=-net) so HR can share links; the server
 * does the filtering, sorting and keyset paging.
 */
export function useListParams(defaults: { sort?: string } = {}) {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const sort = sp.get('sort') ?? defaults.sort ?? '';
  const limit = Number(sp.get('limit') ?? 50);
  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    sp.forEach((v, k) => {
      if (!RESERVED.has(k) && v) f[k] = v;
    });
    return f;
  }, [sp]);

  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === undefined || v === '') next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSp],
  );

  const clearFilters = useCallback(() => {
    setSp(
      (prev) => {
        const next = new URLSearchParams();
        for (const k of ['tab', 'sort', 'limit']) {
          const v = prev.get(k);
          if (v) next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  }, [setSp]);

  const toggleSort = useCallback(
    (key: string) => {
      const cur = sort.replace(/^-/, '');
      const desc = sort.startsWith('-');
      set({ sort: cur === key ? (desc ? key : `-${key}`) : key });
    },
    [sort, set],
  );

  const apiParams = useMemo(() => {
    const p: Record<string, string | number> = { limit };
    if (q) p.q = q;
    if (sort) p.sort = sort;
    for (const [k, v] of Object.entries(filters)) p[`filter[${k}]`] = v;
    return p;
  }, [q, sort, limit, filters]);

  return { q, sort, limit, filters, set, clearFilters, toggleSort, apiParams, searchParams: sp };
}

/** Keyset paging over a list endpoint: next/previous via a stack of cursors. */
export function useKeysetList<T>(key: unknown[], path: string, params: Record<string, string | number>, enabled = true) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const paramsKey = JSON.stringify(params);
  useEffect(() => setCursors([null]), [paramsKey]);
  const cursor = cursors[cursors.length - 1];
  const query = useQuery({
    queryKey: [...key, paramsKey, cursor],
    queryFn: () => api.get<ListResponse<T>>(path, { ...params, ...(cursor ? { cursor } : {}) }),
    placeholderData: keepPreviousData,
    enabled,
  });
  const page = cursors.length;
  return {
    ...query,
    rows: query.data?.data ?? [],
    total: query.data?.meta.total ?? 0,
    meta: query.data?.meta,
    page,
    hasNext: !!query.data?.meta.nextCursor,
    hasPrev: cursors.length > 1,
    next: () => query.data?.meta.nextCursor && setCursors((c) => [...c, query.data!.meta.nextCursor]),
    prev: () => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c)),
    reset: () => setCursors([null]),
  };
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // storage unavailable
    }
  };
  return [v, set];
}
