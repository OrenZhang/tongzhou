import { z } from 'zod';
import { manual, operation, workspaceOperation } from '../../core/tools/client-commands';
import { computerDiagnostic } from '../../services/desktop/computer-diagnostic';
import type { Plugin } from 'cordis';
import '../context';

export const computerPlugin: Plugin.Object<void> = {
  name: 'tongzhou-computer',
  inject: ['tzIpc', 'tzStore', 'tzRuntime', 'tzDesktop'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = ctx.tzRuntime;
    const { computer, computerPermissions, computerPermissionPanel } = ctx.tzDesktop;
    const computerStatus = () => ({
      ...computer.status(),
      diagnostic: store.list<any>('computerDiagnostic')[0],
    });
    register(
      'computerStatus',
      operation('电脑控制', 'query', '查询电脑控制平台状态及上次自检结果', []),
      computerStatus,
    );
    register(
      'computerPermission',
      workspaceOperation(store, '电脑控制', 'change', '检查或申请系统权限', []),
      () => {
        computer.requestPermission();
        return computerStatus();
      },
    );
    register(
      'computerPermissionGuide',
      operation('电脑控制', 'query', '查看 macOS 系统授权所需的当前应用', []),
      () => computerPermissions.guide(),
    );
    register(
      'computerOpenPermissionSettings',
      manual('电脑控制', '打开 macOS 系统权限设置', 'extensions', '需要用户在系统设置中授权', [
        z.enum(['accessibility', 'screen']),
      ]),
      (permission) =>
        computerPermissionPanel.open(z.enum(['accessibility', 'screen']).parse(permission)),
    );
    register(
      'computerRevealApplication',
      manual('电脑控制', '在 Finder 中显示当前应用', 'extensions', '由用户选择需要授权的应用'),
      () => computerPermissions.revealApplication(),
    );
    let diagnosing = false;
    register(
      'computerSelfTest',
      manual(
        '电脑控制',
        '运行电脑控制本机自检',
        'extensions',
        '自检需保持测试窗口可见且所有会话空闲，请在能力卡片操作',
        [],
      ),
      async () => {
        if (diagnosing) throw new Error('自检正在进行');
        if (runtime.snapshot().runs.some((r) => r.status === 'running'))
          throw new Error('有任务正在运行，请等待结束或停止任务后再检测电脑控制。');
        diagnosing = true;
        try {
          const result = await computerDiagnostic(computer);
          store.put('computerDiagnostic', { id: 'current', ...result });
          return computerStatus();
        } finally {
          diagnosing = false;
        }
      },
    );
    register(
      'emergencyStop',
      manual(
        '电脑控制',
        '停止全部运行任务',
        'extensions',
        '包含当前任务，请使用停止按钮或紧急停止快捷键',
        [],
      ),
      async () => {
        runtime.terminals.stopAll();
        for (const r of runtime.snapshot().runs)
          if (r.status === 'running') await runtime.cancel(r.sessionId);
      },
    );
  },
};
