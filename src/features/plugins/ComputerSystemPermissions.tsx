import { Monitor, ShieldCheck } from 'lucide-react';
import { MacComputerPermissions } from './MacComputerPermissions';
import type { ComputerStatus, TongzhouAPI } from '../../shared/types';

export function ComputerSystemPermissions({
  api,
  status,
  onStatus,
}: {
  api: TongzhouAPI;
  status: ComputerStatus;
  onStatus: (next: ComputerStatus) => void;
}) {
  if (status.platform === 'darwin')
    return <MacComputerPermissions api={api} status={status} onStatus={onStatus} />;
  const windows = status.platform === 'win32';
  const linuxX11 = status.platform === 'linux' && status.supported;
  return (
    <section
      className="computer-permission-guide"
      aria-label={windows ? 'Windows 电脑控制说明' : '当前系统电脑控制说明'}
    >
      <div className="computer-permission-heading">
        {windows ? <ShieldCheck size={18} /> : <Monitor size={18} />}
        <div>
          <strong>
            {windows
              ? 'Windows 使用条件'
              : status.platform === 'linux'
                ? 'Linux 支持状态'
                : '当前系统支持状态'}
          </strong>
          <p>
            {windows || linuxX11
              ? '无需单独授权屏幕录制或辅助功能。请运行本机检测，确认窗口识别、截图和输入可用。'
              : '当前版本仅支持在 Windows 和 macOS 上进行电脑控制。此系统暂不支持截图、点击和输入。'}
          </p>
        </div>
      </div>
      <p className="capability-note">
        {windows
          ? '请在已登录的桌面中操作普通应用窗口。以管理员身份运行的窗口及受保护的窗口可能阻止输入。'
          : linuxX11
            ? '支持 X11 / XWayland 窗口（WSLg 与常见桌面均默认使用）。原生 Wayland 窗口暂不支持。'
            : '仍可使用会话、项目文件与终端、客户端管理等功能。'}
      </p>
    </section>
  );
}
