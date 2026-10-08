import { app, nativeImage, shell, type NativeImage, type WebContents } from 'electron';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ComputerPermissionGuide } from '../../../src/shared/types';

export type ComputerPermission = 'accessibility' | 'screen';
const settings = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

export function macApplicationPath(executable: string) {
  const directory = path.dirname(executable);
  const contents = path.dirname(directory);
  const bundle = path.dirname(contents);
  if (
    path.basename(directory) !== 'MacOS' ||
    path.basename(contents) !== 'Contents' ||
    !bundle.endsWith('.app')
  )
    throw new Error('未找到正在运行的 macOS 应用，请使用应用安装包启动同舟。');
  return bundle;
}

/** Only the running application can be revealed or dragged from the permission guide. */
export class ComputerPermissions {
  private loading?: Promise<ComputerPermissionGuide>;
  private application?: { guide: ComputerPermissionGuide; icon: NativeImage };
  constructor(private platform = process.platform) {}

  async guide(): Promise<ComputerPermissionGuide | null> {
    if (this.platform !== 'darwin') return null;
    if (!this.loading) {
      this.loading = this.load().catch((error) => {
        this.loading = undefined;
        throw error;
      });
    }
    return this.loading;
  }

  private async load() {
    const applicationPath = macApplicationPath(await realpath(app.getPath('exe')));
    if (!(await stat(applicationPath)).isDirectory())
      throw new Error('应用文件不存在，请重新启动同舟。');
    const icon = nativeImage.createFromPath(path.join(__dirname, '../build/icon.png'));
    if (icon.isEmpty()) throw new Error('无法加载应用图标，请重新启动同舟。');
    const guide: ComputerPermissionGuide = {
      name: path.basename(applicationPath),
      path: applicationPath,
      icon: icon.toDataURL(),
      development: !app.isPackaged,
    };
    this.application = { guide, icon: icon.resize({ width: 64, height: 64 }) };
    return guide;
  }

  async openSettings(permission: ComputerPermission) {
    this.requireMac();
    if (!Object.hasOwn(settings, permission)) throw new Error('未知的系统权限');
    await shell.openExternal(settings[permission]);
  }

  async revealApplication() {
    this.requireMac();
    const guide = await this.guide();
    shell.showItemInFolder(guide!.path);
  }

  startDrag(sender: WebContents) {
    this.requireMac();
    if (!this.application) throw new Error('应用图标尚未加载，请稍后重试。');
    sender.startDrag({ file: this.application.guide.path, icon: this.application.icon });
  }

  private requireMac() {
    if (this.platform !== 'darwin') throw new Error('此授权引导仅适用于 macOS。');
  }
}
