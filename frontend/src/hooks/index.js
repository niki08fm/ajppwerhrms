import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../services/api';

export function useDebounced(value, ms = 250) {
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

/** Opens a page's "new" dialog when the URL asks for it (?new=1, from the + New menu), then tidies the URL. */
export function useNewFromUrl(open) {
  const [sp, setSp] = useSearchParams();
  useEffect(() => {
    if (sp.get('new') !== '1') return;
    open();
    setSp(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete('new');
        return n;
      },
      { replace: true },
    );
  }, [sp, setSp, open]);
}

const RESERVED = new Set(['q', 'sort', 'limit', 'tab', 'view', 'new']);

/**
 * The list contract, client side. Filter state lives in the URL
 * (?dept=…&status=ACTIVE&q=kumar&sort=-net) so HR can share links; the server
 * does the filtering, sorting and keyset paging.
 */
export function useListParams(defaults = {}) {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const sort = sp.get('sort') ?? defaults.sort ?? '';
  const limit = Number(sp.get('limit') ?? 50);
  const filters = useMemo(() => {
    const f = {};
    sp.forEach((v, k) => {
      if (!RESERVED.has(k) && v) f[k] = v;
    });
    return f;
  }, [sp]);

  const set = useCallback(
    (patch) => {
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
    (key) => {
      const cur = sort.replace(/^-/, '');
      const desc = sort.startsWith('-');
      set({ sort: cur === key ? (desc ? key : `-${key}`) : key });
    },
    [sort, set],
  );

  const apiParams = useMemo(() => {
    const p = { limit };
    if (q) p.q = q;
    if (sort) p.sort = sort;
    for (const [k, v] of Object.entries(filters)) p[`filter[${k}]`] = v;
    return p;
  }, [q, sort, limit, filters]);

  return { q, sort, limit, filters, set, clearFilters, toggleSort, apiParams, searchParams: sp };
}

/** Keyset paging over a list endpoint: next/previous via a stack of cursors. */
export function useKeysetList(key, path, params, enabled = true) {
  const [cursors, setCursors] = useState([null]);
  const paramsKey = JSON.stringify(params);
  useEffect(() => setCursors([null]), [paramsKey]);
  const cursor = cursors[cursors.length - 1];
  const query = useQuery({
    queryKey: [...key, paramsKey, cursor],
    queryFn: () => api.get(path, { ...params, ...(cursor ? { cursor } : {}) }),
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
    next: () => query.data?.meta.nextCursor && setCursors((c) => [...c, query.data.meta.nextCursor]),
    prev: () => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c)),
    reset: () => setCursors([null]),
  };
}

export function useLocalStorage(key, initial) {
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  const set = (next) => {
    setV(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // storage unavailable
    }
  };
  return [v, set];
}
