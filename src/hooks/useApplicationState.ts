import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot, TongzhouAPI } from '../shared/types';
import { errorMessage } from '../lib/feedback';

const empty: Snapshot = {
  providers: [],
  agents: [],
  projects: [],
  sessions: [],
  runs: [],
  approvals: [],
};

export function useApplicationState(api: TongzhouAPI) {
  const [data, setData] = useState(empty);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const report = useCallback((error: unknown) => setNotice(errorMessage(error)), []);
  const refresh = useCallback(async () => {
    const version = ++request.current;
    const snapshot = await api.snapshot();
    if (version !== request.current) return;
    setData(snapshot);
    setLoaded(true);
  }, [api]);
  const perform = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (error) {
        report(error);
      }
    },
    [report],
  );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    void refresh().catch(report);
    const unsubscribe = api.onEvent((event) => {
      if (event.type === 'message' || event.type === 'run-event' || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh().catch(report);
      }, 80);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
      request.current++;
    };
  }, [api, refresh, report]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  return { data, loaded, refresh, notice, setNotice, report, perform };
}
