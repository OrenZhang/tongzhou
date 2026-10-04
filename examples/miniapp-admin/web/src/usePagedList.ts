import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText } from './api';

export interface PagedResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface PagedListState<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
  keyword: string;
  setKeyword: (keyword: string) => void;
  setPage: (page: number) => void;
  loading: boolean;
  error: string;
  reload: () => void;
}

// 通用分页列表 Hook：管理 page/keyword/筛选条件并自动拉取
export function usePagedList<T>(
  path: string,
  filters: Record<string, string> = {},
  pageSize = 10
): PagedListState<T> {
  const [list, setList] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeywordState] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const filterKey = JSON.stringify(filters);
  const queryString = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (keyword.trim()) p.set('keyword', keyword.trim());
    const f = JSON.parse(filterKey) as Record<string, string>;
    for (const [k, v] of Object.entries(f)) {
      if (v) p.set(k, v);
    }
    return p.toString();
  }, [page, pageSize, keyword, filterKey]);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api
      .get<PagedResult<T>>(`${path}?${queryString}`)
      .then((d) => {
        setList(d.list);
        setTotal(d.total);
      })
      .catch((err) => setError(errorText(err)))
      .finally(() => setLoading(false));
  }, [path, queryString]);

  useEffect(() => {
    load();
  }, [load]);

  // 设置关键词并重置到第一页
  const setKeyword = useCallback((kw: string) => {
    setKeywordState(kw);
    setPage(1);
  }, []);

  return { list, total, page, pageSize, keyword, setKeyword, setPage, loading, error, reload: load };
}
