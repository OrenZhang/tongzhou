import { ChoicePicker } from './ChoicePicker';
import { CheckCheck } from 'lucide-react';
import type { PermissionMode, Run, Session, TongzhouAPI } from './shared/types';
import { permissionLabels } from './shared/permissions';

const descriptions: Record<PermissionMode, string> = {
  'read-only': '只查看和分析，不修改工作区',
  ask: '执行需要授权的操作前询问',
  'full-access': '自动批准已启用的工具操作',
};
const options = Object.entries(permissionLabels).map(([value, label]) => ({
  value,
  label,
  detail: descriptions[value as PermissionMode],
}));
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
      <ChoicePicker
        label="会话权限"
        displayLabel={permissionLabels[actual]}
        compact
        value={session.permission ?? 'inherit'}
        options={[
          {
            value: 'inherit',
            label: `继承全局 · ${permissionLabels[defaultPermission]}`,
            detail: '跟随设置中的默认权限',
          },
          ...options,
        ]}
        onChange={(value) =>
          void api
            .setSessionPermission(
              session.id,
              value === 'inherit' ? null : (value as PermissionMode),
            )
            .catch(onError)
        }
      />
      {running && <span>修改下轮生效</span>}
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
        <ChoicePicker
          id="global-permission"
          label="全局默认权限"
          value={value}
          options={options}
          onChange={(next) => void api.setDefaultPermission(next as PermissionMode).catch(onError)}
        />
      </div>
      <p>
        完全开放会自动批准已启用的文件、命令、插件和电脑工具。命令以当前系统用户权限执行；系统授权和插件开关仍然有效。只读
        Agent 与协作分析保持只读。
      </p>
      <div className="settings-row">
        <span>默认用于新会话及选择“继承全局”的会话。</span>
        <button
          className="secondary action-emphasis"
          onClick={() => void api.setDefaultPermission(value, true).catch(onError)}
        >
          <CheckCheck size={15} />
          应用到全部会话
        </button>
      </div>
      <small>应用到全部会话会清除各会话的单独权限设置；运行中的任务从下一轮生效。</small>
    </div>
  );
}
