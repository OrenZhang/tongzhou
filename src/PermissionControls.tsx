import type { PermissionMode, Run, Session, TongzhouAPI } from './shared/types';
import { permissionLabels } from './shared/permissions';

const options = Object.entries(permissionLabels).map(([value, label]) => (
  <option key={value} value={value}>
    {label}
  </option>
));
export function SessionPermission({
  session,
  defaultPermission,
  effective,
  running,
  api,
  onError,
}: {
  session: Session;
  defaultPermission: PermissionMode;
  effective: PermissionMode;
  running?: Run;
  api: TongzhouAPI;
  onError(error: unknown): void;
}) {
  const actual = running?.config?.permission ?? effective;
  return (
    <div className={'session-permission ' + actual}>
      <select
        aria-label="会话权限"
        title="设置此会话的执行权限"
        value={session.permission ?? 'inherit'}
        onChange={(e) =>
          void api
            .setSessionPermission(
              session.id,
              e.target.value === 'inherit' ? null : (e.target.value as PermissionMode),
            )
            .catch(onError)
        }
      >
        <option value="inherit">继承全局 · {permissionLabels[defaultPermission]}</option>
        {options}
      </select>
      <span>
        {running
          ? `本轮：${permissionLabels[actual]} · 修改下轮生效`
          : `当前：${permissionLabels[actual]}`}
      </span>
    </div>
  );
}

export function GlobalPermission({
  value,
  api,
  onError,
}: {
  value: PermissionMode;
  api: TongzhouAPI;
  onError(error: unknown): void;
}) {
  return (
    <div className="global-permission">
      <div className="settings-row">
        <label htmlFor="global-permission">全局默认权限</label>
        <select
          id="global-permission"
          value={value}
          onChange={(e) =>
            void api.setDefaultPermission(e.target.value as PermissionMode).catch(onError)
          }
        >
          {options}
        </select>
      </div>
      <p>
        完全开放会自动批准已启用的文件、命令、插件和电脑工具。命令以当前系统用户权限执行；系统授权和插件开关仍然有效。只读
        Agent 与协作分析保持只读。
      </p>
      <div className="settings-row">
        <span>默认用于新会话及选择“继承全局”的会话。</span>
        <button
          className="secondary"
          onClick={() => void api.setDefaultPermission(value, true).catch(onError)}
        >
          应用到全部会话
        </button>
      </div>
      <small>应用到全部会话会清除各会话的单独权限设置；运行中的任务从下一轮生效。</small>
    </div>
  );
}
