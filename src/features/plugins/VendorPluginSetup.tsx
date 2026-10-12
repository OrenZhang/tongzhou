import { useEffect, useState } from 'react';
import { Field, Spinner } from '../../components/components';
import type { PluginConfig, Provider, TongzhouAPI } from '../../shared/types';
import { vendorPlugin } from '../../shared/vendor-plugins';
import { PluginDetailPage, PluginDetailSection } from './PluginDetail';
import { errorMessage } from '../../lib/feedback';
import { McpPermissions } from './McpPermissions';

export function VendorPluginSetup({
  plugin,
  providers,
  api,
  refresh,
  onClose,
}: {
  plugin: PluginConfig;
  providers: Provider[];
  api: TongzhouAPI;
  refresh(): Promise<void>;
  onClose(): void;
}) {
  const definition = vendorPlugin(plugin.id)!;
  const kimi = plugin.id === 'tongzhou-kimi-web';
  const accounts = providers.filter(
    (p) => p.protocol === (kimi ? 'kimi' : 'minimax') && p.auth === 'native' && p.enabled !== false,
  );
  const [mode, setMode] = useState(
    plugin.accountProviderId || !plugin.hasSecret ? 'account' : 'key',
  );
  const [accountId, setAccountId] = useState(plugin.accountProviderId ?? accounts[0]?.id ?? '');
  const [accountStatus, setAccountStatus] = useState<Record<string, boolean>>({});
  const accountIds = accounts.map((p) => p.id).join(',');
  useEffect(() => {
    let active = true;
    void Promise.all(
      accounts.map(
        async (p) =>
          [
            p.id,
            (await api.nativeStatus(kimi ? 'kimi' : 'minimax', p.id).catch(() => null))
              ?.authenticated === true,
          ] as const,
      ),
    ).then((entries) => {
      if (active) setAccountStatus(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [api, kimi, accountIds]);
  const [key, setKey] = useState('');
  const [region, setRegion] = useState(plugin.hasSecret ? '' : 'cn');
  const [command, setCommand] = useState(plugin.command);
  const [enabled, setEnabled] = useState(plugin.enabled);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [hasSecret, setHasSecret] = useState(plugin.hasSecret);
  const [tools, setTools] = useState<{ name: string; description?: string }[]>(
    plugin.catalog ?? [],
  );
  const save = async (test: boolean) => {
    setBusy(true);
    setNotice('');
    try {
      if (mode === 'account' && !accounts.some((p) => p.id === accountId))
        throw new Error('请先在模型页面登录并启用对应的套餐账号');
      if (mode === 'key' && !key.trim() && !hasSecret) throw new Error('请先填写 API Key');
      if (mode === 'key' && !kimi && key.trim() && !region)
        throw new Error('请选择新 API Key 所属区域');
      await api.savePlugin({
        ...plugin,
        command,
        enabled,
        accountProviderId: mode === 'account' ? accountId : undefined,
        secret:
          mode === 'key' && key.trim()
            ? JSON.stringify(
                kimi
                  ? { KIMI_API_KEY: key.trim() }
                  : {
                      MINIMAX_API_KEY: key.trim(),
                      MINIMAX_API_HOST:
                        region === 'cn' ? 'https://api.minimaxi.com' : 'https://api.minimax.io',
                      MINIMAX_API_RESOURCE_MODE: 'url',
                    },
              )
            : undefined,
      });
      setKey('');
      if (mode === 'key' && key.trim()) setHasSecret(true);
      setRegion('');
      await refresh();
      if (test) {
        const tools = await api.testPlugin(plugin.id);
        setTools(tools);
        await refresh();
        setNotice(
          mode === 'account'
            ? `套餐账号认证配置检查通过，可用 ${tools.length} 个工具。服务权限和额度会在实际调用时验证。`
            : `MCP 连接成功，发现 ${tools.length} 个工具。API Key 的服务权限和额度会在实际调用时验证。`,
        );
      } else onClose();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PluginDetailPage
      title={definition.name}
      subtitle={definition.description}
      busy={busy}
      onClose={onClose}
    >
      <PluginDetailSection title="认证与配置">
        <Field label="认证方式">
          <select
            value={mode}
            disabled={busy}
            onChange={(e) => {
              setMode(e.target.value);
              setTools([]);
              setNotice('');
            }}
          >
            <option value="account">使用同舟套餐账号（推荐）</option>
            <option value="key">单独配置 API Key</option>
          </select>
        </Field>
        {mode === 'account' ? (
          <>
            <Field
              label="套餐账号"
              hint="复用模型页面的账号登录，自动刷新授权；不需要复制 API Key。"
            >
              <select
                value={accountId}
                disabled={busy}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  setTools([]);
                }}
              >
                <option value="">请选择已登录的账号</option>
                {plugin.accountProviderId &&
                  !accounts.some((p) => p.id === plugin.accountProviderId) && (
                    <option value={plugin.accountProviderId} disabled>
                      原账号已停用或移除，请重新选择
                    </option>
                  )}
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                    {accountStatus[account.id] === undefined
                      ? '（检查登录中）'
                      : accountStatus[account.id]
                        ? '（已登录）'
                        : '（需要登录）'}
                  </option>
                ))}
              </select>
            </Field>
            <p>
              {accounts.length
                ? '账号需要在模型页面登录并启用。具体功能权限和额度以当前套餐为准。'
                : '暂无可用账号，请先到模型页面登录并启用 Kimi 或 MiniMax 套餐账号。'}
            </p>
            {plugin.id === 'minimax-multimedia' && (
              <p>
                套餐模式提供图片生成、语音合成、音色查询和视频生成／查询，返回媒体链接。声音克隆、声音设计和本机播放请切换
                API Key 模式。
              </p>
            )}
          </>
        ) : (
          <>
            <Field
              label="API Key"
              hint={
                hasSecret
                  ? '已加密保存；留空保留已有密钥和区域设置。'
                  : '使用系统加密存储，不会写入启动参数。'
              }
            >
              <input
                type="password"
                autoComplete="new-password"
                value={key}
                disabled={busy}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
            {!kimi && (
              <>
                <Field
                  label="密钥所属区域"
                  hint={
                    hasSecret
                      ? '修改区域时需要重新填写该区域的 API Key。'
                      : '区域必须与 API Key 的签发平台一致。'
                  }
                >
                  <select
                    value={region}
                    disabled={busy || (!!hasSecret && !key.trim())}
                    onChange={(e) => setRegion(e.target.value)}
                  >
                    <option value="">
                      {hasSecret ? '保留已保存区域（更换密钥时重新选择）' : '请选择区域'}
                    </option>
                    <option value="cn">中国大陆</option>
                    <option value="global">国际</option>
                  </select>
                </Field>
              </>
            )}
          </>
        )}
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用插件，供会话按需使用
        </label>
        <a
          href={definition.docs}
          onClick={(e) => {
            e.preventDefault();
            void api
              .openExternalLink(definition.docs)
              .catch((error) => setNotice(errorMessage(error)));
          }}
        >
          查看接口与配置说明
        </a>
        {notice && (
          <p role="status" className="info-strip">
            {notice}
          </p>
        )}
      </PluginDetailSection>
      <PluginDetailSection title="依赖与安装">
        {mode === 'key' && !kimi && (
          <>
            <Field
              label="uvx 启动命令"
              hint="需要安装 uv；首次连接会下载固定版本的官方 MCP 及 Python 依赖。可填写 uvx 的绝对路径。"
            >
              <input value={command} disabled={busy} onChange={(e) => setCommand(e.target.value)} />
            </Field>
            <a
              href="https://docs.astral.sh/uv/getting-started/installation/"
              onClick={(e) => {
                e.preventDefault();
                void api
                  .openExternalLink(e.currentTarget.href)
                  .catch((error) => setNotice(errorMessage(error)));
              }}
            >
              uv 安装说明
            </a>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setNotice('正在安装依赖，首次下载可能需要几分钟…');
                void api
                  .installPluginDependencies(plugin.id, command)
                  .then(
                    () => setNotice('依赖已安装，可以填写密钥并检查连接。'),
                    (error) => setNotice(errorMessage(error)),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              安装 / 修复依赖
            </button>
          </>
        )}

        <p>
          {mode === 'account'
            ? '使用同舟内置的套餐适配器，无需 uvx 或 Python 依赖。'
            : kimi
              ? '使用同舟内置 Node.js，无需额外安装依赖。'
              : '使用 uvx 启动官方 MCP；首次连接自动下载固定版本与 Python 依赖。尚未安装 uv 时，请按安装说明完成安装，或填写已有 uvx 的绝对路径。'}
        </p>
      </PluginDetailSection>
      <PluginDetailSection title="可用工具">
        {tools.length ? (
          <ul>
            {tools.map((tool) => (
              <li key={tool.name}>
                <strong>{tool.name}</strong>
                {tool.description && ` — ${tool.description.slice(0, 180)}`}
              </li>
            ))}
          </ul>
        ) : (
          <p>保存并检查连接后，在这里查看插件提供的工具。</p>
        )}
      </PluginDetailSection>
      <PluginDetailSection title="权限与连接校验">
        <McpPermissions plugin={plugin} />
      </PluginDetailSection>
      <div className="modal-footer">
        <button disabled={busy} onClick={() => void save(true)}>
          保存并检查连接
        </button>
        <button className="primary" disabled={busy} onClick={() => void save(false)}>
          {busy && <Spinner />}保存配置
        </button>
      </div>
    </PluginDetailPage>
  );
}
