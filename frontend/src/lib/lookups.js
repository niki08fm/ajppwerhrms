import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export function useLookups() {
  return useQuery({ queryKey: ['lookups'], queryFn: () => api.get('/lookups').then((r) => r.data), staleTime: 5 * 60_000 });
}

export const opts = (xs) => (xs ?? []).map((x) => ({ value: x.id, label: x.name }));
