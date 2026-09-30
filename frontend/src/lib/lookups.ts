import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Lookups {
  departments: { id: string; name: string; colour: string }[];
  pay_groups: { id: string; name: string; calendar_method: string; weekly_off: string[]; structure_id: string }[];
  sites: { id: string; code: string; name: string; state: string; is_active: boolean }[];
  shifts: { id: string; name: string; start_min: number; end_min: number }[];
  structures: { id: string; name: string }[];
  projects: { id: string; code: string; name: string }[];
  pt_states: string[];
  states: string[];
  today: string;
}

export function useLookups() {
  return useQuery({ queryKey: ['lookups'], queryFn: () => api.get<{ data: Lookups }>('/lookups').then((r) => r.data), staleTime: 5 * 60_000 });
}

export const opts = <T extends { id: string; name: string }>(xs: T[] | undefined) => (xs ?? []).map((x) => ({ value: x.id, label: x.name }));
