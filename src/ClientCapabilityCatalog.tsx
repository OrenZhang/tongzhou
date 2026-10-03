import { useState } from 'react';
import { ArrowRight, RefreshCw, Search } from 'lucide-react';
import type { TongzhouAPI } from './shared/types';
import type { ClientCatalog } from './shared/client-catalog';
import { errorMessage } from './feedback';
import { Spinner } from './components';

export function ClientCapabilityCatalog({ api }: { api: TongzhouAPI }) {
  const [catalog, setCatalog] = useState<ClientCatalog>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      setCatalog(await api.clientMethods());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const visible =
    catalog?.methods.filter((m) =>
      (m.module + m.description + m.name).toLowerCase().includes(search.trim().toLowerCase()),
    ) ?? [];
  return (
    <details
      className="capability-details client-capability-catalog"
      onToggle={(e) => {
        if (e.currentTarget.open && !catalog && !busy && !error) void load();
      }}
    >
      <summary>
        查看功能目录
        {catalog && (
          <span>
            {' '}
            · {catalog.modules.length} 个模块 / {catalog.methods.length} 项功能
          </span>
        )}
      </summary>
      <p className="capability-note">
        此目录与会话工具来自同一份功能注册。新增模块自动纳入；停用客户端管理后，仍可在这里查看。
      </p>
      <div className="catalog-toolbar">
        <label className="catalog-search">
          <Search size={14} />
          <input
            aria-label="搜索客户端功能"
            placeholder="搜索模块或功能"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button
          className="icon-button"
          aria-label="刷新功能目录"
          title="刷新功能目录"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? <Spinner /> : <RefreshCw size={14} />}
        </button>
      </div>
      {error && (
        <p role="alert" className="capability-feedback is-error">
          {error}
        </p>
      )}
      {busy && !catalog && <p role="status">正在读取功能目录…</p>}
      {catalog && !visible.length && <p className="muted">没有匹配的功能。</p>}
      <div className="catalog-modules">
        {[...new Set(visible.map((m) => m.module))].map((module) => {
          const methods = visible.filter((m) => m.module === module);
          return (
            <details key={module} className="catalog-module" open={!!search || undefined}>
              <summary>
                {module}
                <span className="muted">{methods.length}</span>
              </summary>
              {methods.map((m) => (
                <div className="catalog-method" key={m.name}>
                  <div>
                    <p>{m.description}</p>
                    {m.reason && <small className="muted">{m.reason}</small>}
                  </div>
                  <span className={'catalog-access ' + m.access}>
                    {m.access === 'query'
                      ? '可查询'
                      : m.access === 'change'
                        ? '按会话权限执行'
                        : '本人操作'}
                  </span>
                  {m.access === 'manual' && m.view && (
                    <button
                      className="icon-button"
                      aria-label={'打开：' + m.description}
                      title="打开对应页面"
                      onClick={() =>
                        void api
                          .openModule(m.view as Parameters<TongzhouAPI['openModule']>[0])
                          .catch((e) => setError(errorMessage(e)))
                      }
                    >
                      <ArrowRight size={14} />
                    </button>
                  )}
                </div>
              ))}
            </details>
          );
        })}
      </div>
    </details>
  );
}
