import { useEffect, useRef, useState } from 'react';
import type {
  CodexAuthState,
  NativeAuthState,
  NativeEngine,
  Provider,
  TongzhouAPI,
} from '../../shared/types';
import type { View } from '../../app/views';

type AccountStatus = { connected: boolean; pending: boolean; error: boolean };
const pending = (phase?: string) => ['starting', 'waiting', 'checking'].includes(phase ?? '');
const codexStatus = (state: CodexAuthState): AccountStatus => ({
  connected: !!state.account,
  pending: pending(state.login?.phase),
  error: !!state.error,
});
const nativeStatus = (state: NativeAuthState): AccountStatus => ({
  connected: state.authenticated,
  pending: pending(state.phase),
  error: !!state.error,
});

export function useAccountState(
  api: TongzhouAPI,
  providers: Provider[],
  view: View,
  report: (error: unknown) => void,
  notify: (message: string) => void,
) {
  const [accountStates, setAccountStates] = useState<Record<string, AccountStatus>>({});
  const [authProviderId, setAuthProviderId] = useState<string>();
  const providerRef = useRef(authProviderId);
  providerRef.current = authProviderId;
  const versions = useRef(new Map<string, number>());
  const [authPanel, setAuthPanel] = useState<'codex' | NativeEngine | null>(null);
  const [codex, setCodex] = useState<CodexAuthState | null>(null);
  const [nativeAccounts, setNativeAccounts] = useState<
    Partial<Record<NativeEngine, NativeAuthState>>
  >({});
  const [nativeRegions, setNativeRegions] = useState<Record<NativeEngine, 'cn' | 'global'>>({
    kimi: 'cn',
    minimax: 'cn',
  });
  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.type !== 'native-auth' && event.type !== 'codex-auth') return;
        const id = event.state.providerId;
        if (id) {
          versions.current.set(id, (versions.current.get(id) ?? 0) + 1);
          const status =
            event.type === 'codex-auth' ? codexStatus(event.state) : nativeStatus(event.state);
          setAccountStates((old) => ({ ...old, [id]: status }));
        }
        if (providerRef.current && id !== providerRef.current) return;
        if (event.type === 'native-auth')
          setNativeAccounts((old) => ({ ...old, [event.state.engine]: event.state }));
        else {
          setCodex(event.state);
          if (event.state.login?.phase === 'success') notify('ChatGPT 授权成功，账号已连接');
        }
      }),
    [api, notify],
  );
  const providerKey = providers.map((p) => `${p.id}:${p.protocol}:${p.enabled}`).join('|');
  useEffect(() => {
    let active = true;
    for (const provider of providers) {
      if (provider.enabled === false) continue;
      const version = versions.current.get(provider.id) ?? 0;
      const request =
        provider.protocol === 'codex'
          ? api.codexStatus(provider.id).then(codexStatus)
          : provider.protocol === 'kimi' || provider.protocol === 'minimax'
            ? api.nativeStatus(provider.protocol, provider.id).then(nativeStatus)
            : null;
      const update = (status: AccountStatus) => {
        if (active && version === (versions.current.get(provider.id) ?? 0))
          setAccountStates((old) => ({ ...old, [provider.id]: status }));
      };
      void request
        ?.then(update)
        .catch(() => update({ connected: false, pending: false, error: true }));
    }
    return () => {
      active = false;
    };
  }, [api, view, providerKey]);
  useEffect(() => {
    if (!authPanel && view !== 'providers') return;
    let active = true;
    const id = authPanel ? authProviderId : undefined;
    const guard = (providerId: string) => {
      const version = versions.current.get(providerId) ?? 0;
      return () => active && version === (versions.current.get(providerId) ?? 0);
    };
    if (!authPanel || authPanel === 'codex') {
      const current = guard(id ?? 'openai-codex');
      void api
        .codexStatus(id)
        .then((state) => {
          if (current()) setCodex(state);
        })
        .catch((error) => {
          if (active) report(error);
        });
    }
    for (const engine of ['kimi', 'minimax'] as const) {
      if (authPanel && authPanel !== engine) continue;
      const current = guard(id ?? `${engine}-account`);
      void api
        .nativeStatus(engine, id)
        .then((state) => {
          if (current()) setNativeAccounts((old) => ({ ...old, [engine]: state }));
        })
        .catch((error) => {
          if (active) report(error);
        });
    }
    return () => {
      active = false;
    };
  }, [api, view, authPanel, authProviderId, report]);
  return {
    accountStates,
    authProviderId,
    setAuthProviderId,
    authPanel,
    setAuthPanel,
    codex,
    setCodex,
    nativeAccounts,
    setNativeAccounts,
    nativeRegions,
    setNativeRegions,
    authPending: pending(codex?.login?.phase),
  };
}
