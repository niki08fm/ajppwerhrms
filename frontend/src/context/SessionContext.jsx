import { createContext, useContext, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, setUnauthenticatedHandler } from '../services/api';

const Ctx = createContext({ me: null, loading: true, can: () => false });

export function SessionProvider({ children }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const { data, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get('/auth/me').then((r) => r.data),
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
