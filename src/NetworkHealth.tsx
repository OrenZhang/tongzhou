import type { NetworkProfile, NetworkProbe } from './shared/network-profile';
import type { TongzhouAPI } from './shared/types';
const status = {
  ok: '可达',
  timeout: '超时',
  dns: 'DNS 失败',
  tls: 'TLS 失败',
  blocked: '服务受限',
  failed: '连接失败',
};
function Probe({ value }: { value: NetworkProbe }) {
  return (
    <span className={value.status === 'ok' ? 'network-probe-ok' : 'muted'} title={value.target}>
      {value.status === 'ok' ? `${value.ms} ms` : status[value.status]}
    </span>
  );
}
export function NetworkHealth({
  p,
  api,
  busy,
  act,
}: {
  p: NetworkProfile;
  api: TongzhouAPI;
  busy: boolean;
  act: (key: string, fn: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const sorted = [...(p.health?.results || [])].sort((a, b) => {
    const score = (n: typeof a) =>
      n.auth.status === 'ok' && n.chatgpt.status === 'ok' ? n.auth.ms! + n.chatgpt.ms! : Infinity;
    return score(a) - score(b) || a.node.localeCompare(b.node);
  });
  return (
    <div className="network-health">
      <label className="network-routing">
        出口策略
        <select
          aria-label={`${p.name}的出口策略`}
          disabled={busy || !!p.checking}
          value={p.routing || 'manual'}
          onChange={(e) =>
            void act(
              p.id,
              () => api.setNetworkRouting(p.id, e.target.value as 'manual' | 'auto'),
              '出口策略已更新',
            )
          }
        >
          <option value="manual">手动选择</option>
          <option value="auto">自动优选（OpenAI + ChatGPT）</option>
        </select>
      </label>
      <p className="muted">
        自动模式按登录与 ChatGPT 的延迟优选出口，检测结果缓存 5
        分钟；不会在其他任务运行时切换节点。检测不代表账号权益或推理成功。
      </p>
      <div className="row network-actions">
        <button
          className="secondary"
          disabled={busy || !!p.checking}
          onClick={() => void act(p.id, () => api.checkNetworkNodes(p.id), '检测完成')}
        >
          检测全部节点
        </button>
        <button
          className="secondary"
          disabled={busy || !!p.checking}
          onClick={() => void act(p.id, () => api.checkNetworkNodes(p.id, p.selected), '检测完成')}
        >
          检测当前节点
        </button>
        {p.checking && (
          <button className="text-button" onClick={() => void api.cancelNetworkCheck(p.id)}>
            取消检测
          </button>
        )}
        {p.health?.recommended && (
          <button
            className="text-button"
            disabled={busy || !!p.checking || p.selected === p.health.recommended}
            onClick={() =>
              void act(
                p.id,
                () => api.selectNetworkNode(p.id, p.health!.recommended!),
                '已使用推荐节点',
              )
            }
          >
            使用推荐节点
          </button>
        )}
      </div>
      {p.checking && (
        <p role="status">
          正在检测 {p.checking.completed} / {p.checking.total} · 结果陆续显示
        </p>
      )}
      {sorted.length > 0 && (
        <details open className="network-health-results">
          <summary>
            节点检测 · 按服务延迟排序
            {p.health?.checkedAt ? ` · ${new Date(p.health.checkedAt).toLocaleTimeString()}` : ''}
          </summary>
          <p className="muted">
            普通联网使用备用检测网址重试。显示请求延迟，不是下载带宽；能联网不一定能访问 ChatGPT。
          </p>
          <div className="network-health-scroll">
            <table>
              <thead>
                <tr>
                  <th>节点</th>
                  <th>普通联网</th>
                  <th>OpenAI 登录</th>
                  <th>ChatGPT</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((n) => (
                  <tr key={n.node}>
                    <td>
                      {n.node}
                      {n.node === p.selected
                        ? ' · 当前'
                        : n.node === p.health?.recommended
                          ? ' · 推荐'
                          : ''}
                    </td>
                    <td>
                      <Probe value={n.internet} />
                    </td>
                    <td>
                      <Probe value={n.auth} />
                    </td>
                    <td>
                      <Probe value={n.chatgpt} />
                    </td>
                    <td>
                      <button
                        disabled={busy || !!p.checking || n.node === p.selected}
                        className="text-button"
                        aria-label={`使用节点 ${n.node}`}
                        onClick={() =>
                          void act(
                            p.id,
                            () => api.selectNetworkNode(p.id, n.node),
                            '出口节点已切换',
                          )
                        }
                      >
                        使用
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
