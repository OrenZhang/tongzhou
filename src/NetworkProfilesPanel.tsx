import { useEffect, useState } from 'react';
import { Network, Plus, RefreshCw, Download, Play, Square } from 'lucide-react';
import { Field, Modal } from './components';
import { errorMessage } from './feedback';
import type { TongzhouAPI } from './shared/types';
import type {
  NetworkOverview,
  NetworkProfile,
  NetworkProfileInput,
} from './shared/network-profile';

const labels = { stopped: '按需启动', starting: '启动中', running: '运行中', error: '异常' };
function template(type: string) {
  return JSON.stringify(
    {
      proxies: [
        {
          name: '我的节点',
          type,
          server: '填写服务器地址',
          port: 443,
          ...(['ss', 'trojan', 'hysteria2', 'tuic'].includes(type) ? { password: '填写密码' } : {}),
          ...(['vmess', 'vless', 'tuic'].includes(type) ? { uuid: '填写UUID' } : {}),
          ...(type === 'ss' ? { cipher: 'aes-128-gcm' } : {}),
          ...(['vmess', 'vless'].includes(type) ? { tls: true } : {}),
        },
      ],
    },
    null,
    2,
  );
}
export function NetworkProfilesPanel({ api }: { api: TongzhouAPI }) {
  const [data, setData] = useState<NetworkOverview>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [edit, setEdit] = useState<NetworkProfileInput | null>(null);
  const [deleting, setDeleting] = useState<NetworkProfile | null>(null);
  const refresh = async () => setData(await api.networkProfiles());
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .networkProfiles()
        .then((v) => {
          if (live) setData(v);
        })
        .catch((e) => {
          if (live) setNotice(errorMessage(e));
        });
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api]);
  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setNotice('');
    try {
      const result = await fn();
      setNotice(typeof result === 'string' ? result : success);
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy('');
      await refresh().catch(() => {});
    }
  };
  return (
    <div className="network-profiles">
      <div className="collection-toolbar">
        <div>
          <h2>网络配置</h2>
          <p>同舟运行自己的代理内核。导入节点后，在 ChatGPT 连接中选择使用，无需另开代理软件。</p>
        </div>
        <button
          className="primary"
          disabled={!!busy}
          onClick={() => {
            setNotice('');
            setEdit({ id: crypto.randomUUID(), name: '', source: 'config', config: '' });
          }}
        >
          <Plus size={14} />
          添加配置
        </button>
      </div>
      {notice && (
        <p className="info-strip" role="status">
          {notice}
        </p>
      )}
      <article className="network-core-card">
        <Network size={20} />
        <div>
          <strong>
            Mihomo <span className="muted">{data?.core.version}</span>
          </strong>
          <p>
            {data?.core.installed
              ? '内核已安装 · 随账号使用自动启动 · 退出同舟时停止'
              : '首次使用安装内核，此后无需重复下载。不会开启系统代理或 TUN。'}
          </p>
          {!data?.core.installed && (
            <small className="muted">离线压缩包：{data?.core.asset || '读取中…'}</small>
          )}
          <p className="muted">
            独立进程 · GPL-3.0 ·{' '}
            <a
              href="https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.32"
              target="_blank"
              rel="noreferrer"
            >
              官方发布与源码
            </a>
          </p>
        </div>
        {data && !data.core.installed && (
          <div className="row">
            <button
              disabled={!!busy}
              className="secondary"
              onClick={() => void act('install', () => api.installNetworkCore(false), '已安装')}
            >
              <Download size={14} />
              {busy === 'install' ? '正在下载并校验…' : '安装内核'}
            </button>
            <button
              disabled={!!busy}
              className="secondary"
              onClick={() => void act('offline', () => api.installNetworkCore(true), '已安装')}
            >
              离线安装
            </button>
          </div>
        )}
      </article>
      <div className="network-profile-list">
        {data?.profiles.map((p) => (
          <article className="network-profile-card" key={p.id}>
            <div className="row service-card-heading">
              <h3>{p.name}</h3>
              <span className={'tag' + (p.status === 'error' ? ' danger' : '')}>
                {labels[p.status]}
                {p.latency !== undefined ? ` · ${p.latency} ms` : ''}
              </span>
            </div>
            <p className="muted">
              {p.source === 'subscription' ? '订阅' : '本地配置'} · {p.nodes.length} 个节点 ·{' '}
              {p.usedBy.length ? '用于 ' + p.usedBy.join('、') : '尚未绑定账号'}
            </p>
            <Field label="出口节点">
              <select
                aria-label={`${p.name}的出口节点`}
                value={p.selected}
                disabled={!!busy}
                onChange={(e) =>
                  void act(
                    p.id,
                    () => api.selectNetworkNode(p.id, e.target.value),
                    '出口节点已切换',
                  )
                }
              >
                {p.nodes.map((n) => (
                  <option value={n} key={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            {p.error && (
              <p className="error" role="status">
                {p.error}
              </p>
            )}
            <div className="row network-actions">
              <button
                className="secondary"
                disabled={!!busy || !data.core.installed}
                onClick={() => void act(p.id, () => api.testNetworkProfile(p.id), '网络可达')}
              >
                {busy === p.id ? '处理中…' : '测试出口'}
              </button>
              <button
                className="secondary"
                disabled={!!busy || !data.core.installed}
                onClick={() =>
                  void act(
                    p.id,
                    () =>
                      p.status === 'running'
                        ? api.stopNetworkProfile(p.id)
                        : api.startNetworkProfile(p.id),
                    p.status === 'running' ? '已停止；账号下次使用时会自动启动' : '内核已启动',
                  )
                }
              >
                {p.status === 'running' ? <Square size={13} /> : <Play size={13} />}{' '}
                {p.status === 'running' ? '停止' : '启动'}
              </button>
              {p.source === 'subscription' && (
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    void act(
                      p.id,
                      () => api.refreshNetworkProfile(p.id),
                      '订阅已更新；下次使用时重新启动',
                    )
                  }
                >
                  <RefreshCw size={13} />
                  更新订阅
                </button>
              )}
              <button
                disabled={!!busy}
                className="text-button"
                onClick={() => {
                  setNotice('');
                  setEdit({ id: p.id, name: p.name, source: p.source });
                }}
              >
                编辑
              </button>
              <button
                disabled={!!busy}
                className="text-button danger"
                onClick={() => setDeleting(p)}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
      {data && !data.profiles.length && (
        <div className="empty-state compact">
          <Network size={28} />
          <h3>添加你的第一个网络配置</h3>
          <p>
            支持 Clash / Mihomo YAML、JSON 与节点订阅。需要有效的节点或订阅；同舟不提供网络出口。
          </p>
        </div>
      )}
      {edit && (
        <Modal
          title={data?.profiles.some((p) => p.id === edit.id) ? '编辑网络配置' : '添加网络配置'}
          onClose={() => {
            if (!busy) setEdit(null);
          }}
        >
          <form
            className="modal-content connection-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                'save',
                async () => {
                  await api.saveNetworkProfile(edit);
                  setEdit(null);
                },
                '网络配置已保存，可在 ChatGPT 连接中选择使用',
              );
            }}
          >
            <Field label="名称">
              <input
                required
                maxLength={80}
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                placeholder="例如：日常工作网络"
              />
            </Field>
            <Field label="配置来源">
              <select
                value={edit.source}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    source: e.target.value as NetworkProfileInput['source'],
                    config: '',
                    subscriptionUrl: '',
                  })
                }
              >
                <option value="config">文件 / 手动配置</option>
                <option value="subscription">订阅地址</option>
              </select>
            </Field>
            {edit.source === 'subscription' ? (
              <Field
                label="HTTPS 订阅地址"
                hint="使用提供商的 Clash / Mihomo 节点订阅。地址加密保存；编辑时留空保留原地址。下载使用当前系统网络。"
              >
                <input
                  type="password"
                  autoComplete="off"
                  value={edit.subscriptionUrl || ''}
                  onChange={(e) => setEdit({ ...edit, subscriptionUrl: e.target.value })}
                  placeholder="https://…"
                />
              </Field>
            ) : (
              <>
                <div className="row">
                  <label className="secondary network-file-input">
                    导入 YAML / JSON
                    <input
                      aria-label="导入网络配置文件"
                      type="file"
                      accept=".yaml,.yml,.json"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        if (file.size > 2_000_000) {
                          setNotice('配置文件不能超过 2 MB');
                          return;
                        }
                        try {
                          const config = await file.text();
                          setEdit((v) => (v ? { ...v, config } : v));
                        } catch {
                          setNotice('读取文件失败');
                        }
                      }}
                    />
                  </label>
                  <select
                    aria-label="插入协议模板"
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) setEdit({ ...edit, config: template(e.target.value) });
                      e.target.value = '';
                    }}
                  >
                    <option value="">协议模板…</option>
                    {['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'http', 'socks5'].map(
                      (p) => (
                        <option value={p} key={p}>
                          {p.toUpperCase()}
                        </option>
                      ),
                    )}
                  </select>
                </div>
                <Field
                  label="节点配置"
                  hint="保存时只提取 proxies 节点。同舟自行管理出口选择，原文件的规则、TUN、DNS 和监听设置不生效。已有配置留空则保留。"
                >
                  <textarea
                    className="network-config-editor"
                    rows={9}
                    spellCheck={false}
                    autoComplete="off"
                    value={edit.config || ''}
                    onChange={(e) => setEdit({ ...edit, config: e.target.value })}
                    placeholder={'proxies:\n  - name: 我的节点\n    type: …'}
                  />
                </Field>
              </>
            )}
            <p className="muted">
              节点密码与订阅地址加密保存在本机，不会提供给模型。暂不支持 OpenVPN 文件、Base64
              订阅及仅含远程 proxy-providers 的配置。
            </p>
            {notice && (
              <p role="status" className="info-strip">
                {notice}
              </p>
            )}
            <div className="row">
              <button
                type="button"
                className="secondary"
                disabled={!!busy}
                onClick={() => setEdit(null)}
              >
                取消
              </button>
              <button className="primary" disabled={!!busy}>
                {busy === 'save' ? '正在验证并保存…' : '保存配置'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="删除网络配置"
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
        >
          <div className="modal-content">
            <p>删除“{deleting.name}”及其保存的节点凭据？已绑定账号的配置需要先解除绑定。</p>
            {notice && <p role="status">{notice}</p>}
            <div className="row">
              <button className="secondary" disabled={!!busy} onClick={() => setDeleting(null)}>
                取消
              </button>
              <button
                disabled={!!busy}
                onClick={() =>
                  void act(
                    'delete',
                    async () => {
                      await api.deleteNetworkProfile(deleting.id);
                      setDeleting(null);
                    },
                    '网络配置已删除',
                  )
                }
              >
                确认删除
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
