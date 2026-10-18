import { pluginLabel } from '../../shared/plugin-label';
import { t as tr, localize as localized } from '../../shared/i18n';
import { builtinApps as raw_builtinApps } from '../../shared/builtin-apps';
import { useState } from 'react';
import { Plus, Plug, Search, Trash2, BookOpen, Bot } from 'lucide-react';
import { Field, Modal, Spinner } from '../../components/components';
import { MultiValueInput } from '../../components/controls/MultiValueInput';
import {
  OAuthFields,
  WorkPlugins,
  workPluginCatalog,
  PluginAuthStatus,
  workPluginDefinition,
} from './WorkPlugins';
import { errorMessage } from '../../lib/feedback';
import { CoreCapabilities } from './CoreCapabilities';
import { builtinPlugins as raw_builtinPlugins } from '../../shared/builtin-plugins';
import { vendorPlugins as raw_vendorPlugins, vendorPlugin } from '../../shared/vendor-plugins';
import { VendorPluginSetup } from './VendorPluginSetup';
import { PluginTile, PluginDetailPage, PluginDetailSection } from './PluginDetail';
import { builtinSkills as raw_builtinSkills, isBuiltinSkill } from '../../shared/builtin-skills';
import type { PluginConfig, PluginInput, Snapshot, TongzhouAPI } from '../../shared/types';
import { codeHost } from '../../shared/code-hosting';
import { configureFigmaPlugin, figmaConnection } from '../../shared/figma';
import { FigmaConnectionInfo, McpPermissions, PluginToolList } from './McpPermissions';
import { pluginPermissionState } from '../../shared/plugin-permissions';

export function Extensions({
  api,
  data,
  refresh,
  onAccountLogin,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  refresh: () => Promise<void>;
  onAccountLogin(engine: 'kimi' | 'minimax', providerId?: string): Promise<string | undefined>;
}) {
  const [tab, setTab] = useState<'core' | 'builtin' | 'personal'>('core');
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [edit, setEdit] = useState<PluginInput | null>(null);
  const [vendorEdit, setVendorEdit] = useState<PluginConfig | null>(null);
  const [detail, setDetail] = useState<{ kind: 'app' | 'skill' | 'builtin'; id: string }>();
  const [busy, setBusy] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<{ id: string; enabled: boolean } | null>(null);
  const [notice, setNotice] = useState('');
  const permissionState = edit
    ? pluginPermissionState(
        edit,
        data.plugins?.find((p) => p.id === edit.id),
      )
    : undefined;
  const otherPlugins = (data.plugins ?? []).filter((p) => !workPluginDefinition(p));
  const definitions = [...builtinPlugins, ...vendorPlugins];
  const builtinIds = new Set<string>(definitions.map((p) => p.id));
  const matchesQuery = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const visiblePlugins = otherPlugins.filter(
    (p) =>
      (tab === 'builtin' ? builtinIds.has(p.id) : !builtinIds.has(p.id)) &&
      (kind === 'all' || kind === 'mcp') &&
      matchesQuery(pluginLabel(p) + (definitions.find((b) => b.id === p.id)?.description ?? p.url)),
  );
  const visibleSkills =
    kind === 'all' || kind === 'skill'
      ? (data.skills ?? []).filter(
          (s) =>
            (tab === 'builtin' ? isBuiltinSkill(s.id) : !isBuiltinSkill(s.id)) &&
            matchesQuery(
              s.name + s.description + (builtinSkills.find((b) => b.id === s.id)?.title ?? ''),
            ),
        )
      : [];
  const showApps = tab === 'builtin' && (kind === 'all' || kind === 'app');
  const localApps = showApps ? builtinApps.filter((p) => matchesQuery(p.name + p.description)) : [];
  const matchingApps = showApps
    ? workPluginCatalog.filter((p) => matchesQuery(p.name + p.category + p.description))
    : [];
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async (test = false) => {
    if (!edit) return;
    const input = configureFigmaPlugin(edit);
    await api.savePlugin(input);
    if (test) {
      setEdit({
        ...input,
        secret: '',
        clearSecret: false,
        oauthClientSecret: '',
        clearOAuthClientSecret: false,
      });
      const tools = await api.testPlugin(edit.id);
      setNotice(
        tr('{0}：目录和只读配置检查通过，发现 {1} 个工具；未执行写操作', [edit.name, tools.length]),
      );
    } else setEdit(null);
  };
  return (
    <main className="page extensions-page">
      <div id="plugin-detail-outlet" className="plugin-detail-outlet" />
      <div className="page-heading">
        <h1>{tr('插件')}</h1>
        <p>{tr('管理CoSail的核心能力、内置插件和个人插件，供所有会话与 Agent 按需使用。')}</p>
      </div>
      <nav className="section-tabs" aria-label={tr('插件来源')}>
        {(['core', 'builtin', 'personal'] as const).map((value, i) => (
          <button
            key={value}
            aria-pressed={tab === value}
            title={
              value === 'builtin'
                ? tr('CoSail预设的应用、MCP 与技能')
                : value === 'personal'
                  ? tr('你接入的 MCP 服务和导入的技能')
                  : tr('CoSail内置的基础能力')
            }
            className={tab === value ? 'active' : ''}
            onClick={() => {
              setTab(value);
              setKind('all');
              setQuery('');
              setNotice('');
            }}
          >
            {[tr('核心能力'), tr('内置插件'), tr('个人插件')][i]}
            <span className="tab-count">
              {value === 'core'
                ? 3
                : value === 'builtin'
                  ? workPluginCatalog.length +
                    builtinApps.length +
                    otherPlugins.filter((p) => builtinIds.has(p.id)).length +
                    (data.skills ?? []).filter((s) => isBuiltinSkill(s.id)).length
                  : otherPlugins.filter((p) => !builtinIds.has(p.id)).length +
                    (data.skills ?? []).filter((s) => !isBuiltinSkill(s.id)).length}
            </span>
          </button>
        ))}
      </nav>
      {notice && !edit && tab === 'core' && (
        <p role="status" className="info-strip">
          {notice}
        </p>
      )}
      {tab === 'core' && <CoreCapabilities api={api} data={data} refresh={refresh} />}
      {tab !== 'core' && (
        <div className="plugin-library">
          <div className="section-heading">
            <div>
              <h2>{tab === 'builtin' ? tr('内置插件') : tr('个人插件')}</h2>
            </div>
            {tab === 'personal' && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  setNotice('');
                  setQuery('');
                  setAdding(true);
                }}
              >
                <Plus size={16} />
                {tr('添加插件')}
              </button>
            )}
          </div>
          <div className="plugin-list-filter">
            <label htmlFor="plugin-kind">{tr('类型')}</label>
            <select id="plugin-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="all">{tr('全部类型')}</option>
              <option value="app">{tr('应用')}</option>
              <option value="mcp">MCP</option>
              <option value="skill">{tr('技能')}</option>
            </select>
            <div className="search-box">
              <Search size={14} />
              <input
                aria-label={tr('搜索插件')}
                placeholder={tr('搜索名称或用途')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="provider-grid plugin-library-grid">
            {localApps.map((app) => (
              <PluginTile
                key={app.id}
                name={app.name}
                type={tr('应用')}
                icon={<Bot />}
                enabled
                onOpen={() => setDetail({ kind: 'app', id: app.id })}
              />
            ))}
            {showApps && (
              <WorkPlugins
                api={api}
                data={data}
                refresh={refresh}
                query={query.trim()}
                onManage={(plugin) => {
                  setNotice('');
                  setLoginUrl('');
                  setLoginCode('');
                  setEdit({ ...plugin, secret: '' });
                }}
              />
            )}
            {visiblePlugins.map((p) => (
              <PluginTile
                key={p.id}
                name={pluginLabel(p)}
                type="MCP"
                icon={<Plug />}
                enabled={pendingToggle?.id === p.id ? pendingToggle.enabled : p.enabled}
                disabled={busy}
                onOpen={() => {
                  setNotice('');
                  if (vendorPlugin(p.id)) setVendorEdit(p);
                  else if (builtinIds.has(p.id)) setDetail({ kind: 'builtin', id: p.id });
                  else {
                    setLoginUrl('');
                    setLoginCode('');
                    setEdit({ ...p, secret: '' });
                  }
                }}
                onToggle={(enabled) => {
                  if (enabled && vendorPlugin(p.id) && !p.hasSecret && !p.accountProviderId) {
                    setVendorEdit({ ...p, enabled: true });
                    return;
                  }
                  setPendingToggle({ id: p.id, enabled });
                  void perform(() => api.savePlugin({ ...p, enabled })).finally(() =>
                    setPendingToggle(null),
                  );
                }}
              />
            ))}
            {visibleSkills.map((s) => (
              <PluginTile
                key={'skill:' + s.id}
                name={builtinSkills.find((b) => b.id === s.id)?.title ?? s.name}
                type={tr('技能')}
                icon={<BookOpen />}
                disabled={busy}
                enabled={pendingToggle?.id === 'skill:' + s.id ? pendingToggle.enabled : s.enabled}
                onOpen={() => setDetail({ kind: 'skill', id: s.id })}
                onToggle={(enabled) => {
                  setPendingToggle({ id: 'skill:' + s.id, enabled });
                  void perform(() => api.saveSkill({ ...s, enabled })).finally(() =>
                    setPendingToggle(null),
                  );
                }}
              />
            ))}
          </div>
          {!visiblePlugins.length &&
            !visibleSkills.length &&
            !matchingApps.length &&
            !localApps.length && (
              <div className="empty-state compact">
                <Plug size={26} />
                <h3>{query.trim() ? tr('没有匹配的插件') : tr('暂无此类型的插件')}</h3>
                <p>
                  {query.trim()
                    ? tr('试试其他关键词，或切换类型。')
                    : tab === 'builtin'
                      ? tr('可以切换类型查看其他内置插件。')
                      : kind === 'app'
                        ? tr('暂无个人应用插件，可在“内置插件”中配置现有应用。')
                        : tr('点击“添加插件”，连接 MCP 服务或导入技能。')}
                </p>
              </div>
            )}
          {notice && (
            <p role="status" className="extension-notice">
              {notice}
            </p>
          )}
        </div>
      )}
      {adding && (
        <Modal
          title={tr('添加插件')}
          subtitle={tr('选择要添加的类型')}
          onClose={() => setAdding(false)}
        >
          <div className="modal-content plugin-kind-options">
            <button
              className="plugin-kind-option"
              aria-label={tr('连接 MCP 服务')}
              onClick={() => {
                setAdding(false);
                setKind('all');
                setEdit({
                  id: crypto.randomUUID(),
                  name: '',
                  transport: 'stdio',
                  command: '',
                  args: [],
                  url: '',
                  enabled: true,
                  readOnlyTools: [],
                  secret: '',
                });
              }}
            >
              <Plug size={22} />
              <span>
                <strong>{tr('连接 MCP 服务')}</strong>
                <small>{tr('添加远程服务或本机工具，供会话调用。')}</small>
              </span>
            </button>
            <button
              className="plugin-kind-option"
              aria-label={tr('导入 Skill 技能')}
              onClick={() => {
                setAdding(false);
                setKind('all');
                void perform(async () => {
                  const skill = await api.importSkill();
                  if (skill) setNotice(tr('已导入技能「{0}」', [skill.name]));
                });
              }}
            >
              <BookOpen size={22} />
              <span>
                <strong>{tr('导入 Skill 技能')}</strong>
                <small>{tr('选择含 SKILL.md 的文件夹，添加可复用的工作方法。')}</small>
              </span>
            </button>
          </div>
        </Modal>
      )}
      {detail &&
        (() => {
          const close = () => setDetail(undefined);
          if (detail.kind === 'app') {
            const app = builtinApps.find((a) => a.id === detail.id);
            return (
              app && (
                <PluginDetailPage
                  title={app.name}
                  type={tr('应用')}
                  subtitle={app.description}
                  onClose={close}
                >
                  <PluginDetailSection title={tr('功能配置')}>
                    <p>
                      {tr('内置应用始终可用。各渠道的账号、认证和启用状态在渠道管理中独立配置。')}
                    </p>
                    <button onClick={() => void perform(() => api.openModule(app.view))}>
                      {tr('打开')}
                      {app.name}
                    </button>
                  </PluginDetailSection>
                </PluginDetailPage>
              )
            );
          }
          if (detail.kind === 'skill') {
            const skill = data.skills?.find((s) => s.id === detail.id);
            return (
              skill && (
                <PluginDetailPage
                  title={builtinSkills.find((b) => b.id === skill.id)?.title ?? skill.name}
                  type={tr('技能')}
                  subtitle={isBuiltinSkill(skill.id) ? tr(skill.description) : skill.description}
                  onClose={close}
                >
                  <PluginDetailSection title={tr('技能指令')}>
                    <pre className="skill-preview">{skill.instructions}</pre>
                    <p>
                      {Object.keys(skill.files).length}
                      {tr(' 个附属文本文件')}
                    </p>
                  </PluginDetailSection>
                  {!isBuiltinSkill(skill.id) && (
                    <PluginDetailSection title={tr('管理')}>
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await api.deleteSkill(skill.id);
                            close();
                          })
                        }
                      >
                        <Trash2 size={14} />
                        {tr('移除技能')}
                      </button>
                    </PluginDetailSection>
                  )}
                  {notice && <p role="status">{notice}</p>}
                </PluginDetailPage>
              )
            );
          }
          const p = data.plugins?.find((p) => p.id === detail.id);
          return (
            p && (
              <PluginDetailPage
                title={pluginLabel(p)}
                subtitle={definitions.find((d) => d.id === p.id)?.description}
                onClose={close}
              >
                <PluginDetailSection title={tr('工具与连接')}>
                  <p>{tr('使用CoSail自带运行环境，无需安装依赖或认证。')}</p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const tools = await api.testPlugin(p.id);
                        setNotice(tr('连接成功，发现 ') + tools.length + tr(' 个工具'));
                      })
                    }
                  >
                    {tr('检查连接')}
                  </button>
                  <McpPermissions plugin={p} />
                  {p.catalog && <PluginToolList plugin={p} />}
                </PluginDetailSection>
                {notice && <p role="status">{notice}</p>}
              </PluginDetailPage>
            )
          );
        })()}
      {vendorEdit && (
        <VendorPluginSetup
          onAccountLogin={onAccountLogin}
          plugin={vendorEdit}
          providers={data.providers}
          api={api}
          refresh={refresh}
          onClose={() => setVendorEdit(null)}
        />
      )}
      {edit && (
        <PluginDetailPage
          title={edit.name || tr('新建 MCP 插件')}
          subtitle={tr('仅添加你信任的服务。本地服务会以当前用户权限运行。')}
          busy={busy}
          onClose={() => setEdit(null)}
        >
          <PluginDetailSection title={tr('连接与认证')}>
            <Field label={tr('插件名称')}>
              <input
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </Field>
            <Field label={tr('连接方式')}>
              <select
                value={edit.transport}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    transport: e.target.value as 'stdio' | 'http',
                    authMode: e.target.value === 'stdio' ? 'headers' : edit.authMode,
                    secret: '',
                    clearSecret: true,
                  })
                }
              >
                <option value="stdio">{tr('本地 stdio')}</option>
                <option value="http">{tr('远程 Streamable HTTP')}</option>
              </select>
            </Field>
            {edit.transport === 'stdio' ? (
              <>
                <Field
                  label={tr('启动命令')}
                  hint={tr('例如 node、npx 或已安装程序的绝对路径；不通过 shell 解释。')}
                >
                  <input
                    value={edit.command}
                    onChange={(e) => setEdit({ ...edit, command: e.target.value })}
                  />
                </Field>
                <Field label={tr('启动参数（每行一个）')}>
                  <MultiValueInput
                    label={tr('启动参数')}
                    split={false}
                    value={edit.args}
                    onChange={(args) => setEdit({ ...edit, args })}
                  />
                </Field>
              </>
            ) : (
              <Field label={tr('MCP 服务地址')}>
                <input
                  value={edit.url}
                  onChange={(e) => setEdit(configureFigmaPlugin({ ...edit, url: e.target.value }))}
                />
              </Field>
            )}
            {edit.transport === 'http' && <OAuthFields edit={edit} onChange={setEdit} />}
            {figmaConnection(edit) && <FigmaConnectionInfo plugin={edit} />}
            {edit.authMode !== 'oauth' && !figmaConnection(edit) && (
              <Field
                label={edit.transport === 'stdio' ? tr('环境变量 JSON') : tr('请求头 JSON')}
                hint={
                  edit.hasSecret
                    ? tr('已加密保存；留空保留原值。')
                    : tr('字符串键值对象，例如 {"Authorization":"Bearer …"}。使用系统加密存储。')
                }
              >
                <textarea
                  autoComplete="off"
                  rows={2}
                  value={edit.secret ?? ''}
                  onChange={(e) => setEdit({ ...edit, secret: e.target.value })}
                />
              </Field>
            )}
            {edit.authMode === 'oauth' && (
              <>
                <PluginAuthStatus plugin={data.plugins?.find((p) => p.id === edit.id)} />
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await api.savePlugin(configureFigmaPlugin(edit));
                      setEdit({
                        ...edit,
                        clearSecret: false,
                        oauthClientSecret: '',
                        clearOAuthClientSecret: false,
                      });
                      const result = await api.loginPlugin(edit.id);
                      setLoginUrl(result.url ?? '');
                      setLoginCode(result.code ?? '');
                      setNotice(
                        result.url
                          ? result.browserOpened
                            ? tr('已打开浏览器，请完成授权。')
                            : tr('系统浏览器未打开，请点击下方链接继续授权。')
                          : tr('授权已更新。'),
                      );
                    })
                  }
                >
                  {codeHost(edit) === 'github'
                    ? tr('使用 GitHub 登录')
                    : codeHost(edit) === 'gitlab'
                      ? tr('使用 GitLab 登录')
                      : figmaConnection(edit) === 'remote'
                        ? tr('使用 Figma 登录')
                        : tr('保存并浏览器授权')}
                </button>
                {loginCode &&
                  data.plugins?.find((p) => p.id === edit.id)?.oauthStatus === 'waiting' && (
                    <p className="info-strip">
                      {tr('在 GitHub 授权页面输入验证码：')}
                      <strong>{loginCode}</strong>
                    </p>
                  )}
                {loginUrl && (
                  <a href={loginUrl} target="_blank" rel="noreferrer">
                    {tr('打开授权页面')}
                  </a>
                )}
                {['starting', 'waiting'].includes(
                  data.plugins?.find((p) => p.id === edit.id)?.oauthStatus ?? '',
                ) && (
                  <button
                    onClick={() =>
                      perform(async () => {
                        await api.cancelPluginLogin(edit.id);
                        setLoginUrl('');
                        setLoginCode('');
                      })
                    }
                  >
                    {tr('取消授权')}
                  </button>
                )}
              </>
            )}
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={!!edit.clearSecret}
                onChange={(e) => setEdit({ ...edit, clearSecret: e.target.checked })}
              />
              {tr('清除已保存的环境变量 / 请求头')}
            </label>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={edit.enabled}
                onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
              />
              {tr('启用插件（所有会话按需连接）')}
            </label>
            <Field
              label={tr('允许只读 Agent 使用的工具名（每行一个）')}
              hint={tr(
                '仅填写确认不会修改状态的工具。官方 GitHub/GitLab/Figma 可识别只读声明；保存并检查会校验名称和写操作冲突。',
              )}
            >
              <textarea
                rows={2}
                value={edit.readOnlyTools.join('\n')}
                onChange={(e) =>
                  setEdit({ ...edit, readOnlyTools: e.target.value.split('\n').filter(Boolean) })
                }
              />
            </Field>
            {notice && <p role="status">{notice}</p>}
          </PluginDetailSection>
          <PluginDetailSection title={tr('权限与连接校验')}>
            <McpPermissions plugin={permissionState!} />
            {permissionState?.catalog && <PluginToolList plugin={permissionState} />}
          </PluginDetailSection>
          <div className="modal-footer">
            <button
              className="text-button danger"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await api.deletePlugin(edit.id);
                  setEdit(null);
                })
              }
            >
              {tr('删除插件')}
            </button>
            <span className="spacer" />
            <button className="secondary" disabled={busy} onClick={() => perform(() => save(true))}>
              {tr('保存并检查连接')}
            </button>
            <button className="primary" disabled={busy} onClick={() => perform(() => save())}>
              {busy ? <Spinner /> : null}
              {tr('保存插件')}
            </button>
          </div>
        </PluginDetailPage>
      )}
    </main>
  );
}

const builtinApps = localized(raw_builtinApps);
const builtinPlugins = localized(raw_builtinPlugins);
const vendorPlugins = localized(raw_vendorPlugins);
const builtinSkills = localized(raw_builtinSkills);
