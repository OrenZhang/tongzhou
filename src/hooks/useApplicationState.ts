import { SnapshotLoader } from '../lib/snapshot-loader';
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
  const loader = useRef<SnapshotLoader | null>(null);
  const report = useCallback((error: unknown) => setNotice(errorMessage(error)), []);
  const refresh = useCallback(async () => {
    await loader.current?.load();
  }, []);
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
    const current = new SnapshotLoader(api, (snapshot, full) => {
      setData((previous) => ({ ...previous, ...snapshot }));
      if (full) setLoaded(true);
    });
    loader.current = current;
    let full = false;
    void current.load().catch(report);
    const unsubscribe = api.onEvent((event) => {
      if (!['changed', 'approval'].includes(event.type)) return;
      full ||= event.type === 'changed' && event.scope !== 'tasks';
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void current.load(full).catch(report);
        full = false;
      }, 80);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
      current.dispose();
      if (loader.current === current) loader.current = null;
    };
  }, [api, refresh, report]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  return { data, loaded, refresh, notice, setNotice, report, perform };
}
