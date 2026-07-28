import { useQuery } from '@tanstack/vue-query';
import { api } from '../api';

/** /api/config（model/baseURL/hasAuth），长期缓存。 */
export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: Infinity });
}