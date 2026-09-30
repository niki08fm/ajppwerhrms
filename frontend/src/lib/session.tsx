import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Permission } from '@ajpwer/shared';
import { api, setUnauthenticatedHandler } from './api';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: Permission[];
}

interface SessionCtx {
  me: Me | null;
  loading: boolean;
  can: (p: Permission) => boolean;
}

const Ctx = createContext<SessionCtx>({ me: null, loading: true, can: () => false });

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const { data, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ data: Me }>('/auth/me').then((r) => r.data),
    retry: false,
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      qc.setQueryData(['me'], null);
      if (!location.pathname.startsWith('/login') && !location.pathname.startsWith('/tablet')) {
        nav(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
      }
    });
  }, [qc, nav]);
  void loc;
  const me = data ?? null;
  return <Ctx.Provider value={{ me, loading: isLoading, can: (p) => !!me?.permissions.includes(p) }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
