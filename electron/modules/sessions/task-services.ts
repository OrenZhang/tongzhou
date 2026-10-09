import { z } from 'zod';
import { app, dialog } from 'electron';
import { readFile, writeFile, stat } from 'node:fs/promises';
import type { Store } from '../../services/storage/store';
import type { Runtime } from '../../core/runtime/runtime';
import type { Session, Run } from '../../../src/shared/types';
import { operation, manual, type ClientOperation } from '../../core/tools/client-commands';
import { idSchema } from '../../services/storage/validation';
import { DataMaintenance } from '../../services/storage/data-maintenance';
import { serviceFetch } from '../../services/network/service-network';

export function registerTaskServices(
  register: (name: string, definition: ClientOperation, handler: (...args: any[]) => any) => void,
  store: Store,
  runtime: Pick<Runtime, 'snapshot' | 'terminals' | 'memories' | 'checkpoints' | 'start'>,
  dataDir: string,
) {
  const session = idSchema.describe('sessionId'),
    terminal = idSchema.describe('terminalId');
  const idle = (projectId?: string) => {
    if (
      runtime
        .snapshot()
        .runs.some(
          (r) =>
            r.status === 'running' &&
            (!projectId || store.get<Session>('session', r.sessionId).projectId === projectId),
        )
    )
      throw new Error('请先停止相关运行任务');
  };
  const checkpointIdle = (runId: string) => idle(store.get<any>('runChanges', runId).projectId);
  register(
    'taskState',
    operation('任务与终端', 'query', '读取会话任务记忆、恢复检查点、终端状态和验证证据', [session]),
    (id) => {
      idSchema.parse(id);
      store.get('session', id);
      const evidence = (
        store.db
          .prepare(
            "SELECT value FROM messages WHERE session_id=? AND json_extract(value,'$.role')='tool' ORDER BY seq DESC LIMIT 30",
          )
          .all(id) as { value: string }[]
      )
        .map((r) => JSON.parse(r.value))
        .map((m) => ({
          id: m.id,
          runId: m.runId,
          toolName: m.toolName,
          content: m.content.slice(-5000),
          status: m.status,
        }));
      return {
        cwd: runtime.terminals.cwd(id),
        memory: runtime.memories.read(id),
        runs: store.sessionObjects<Run>('run', id, 30).reverse(),
        terminals: runtime.terminals.list(id).map(({ output, ...t }) => t),
        changes: runtime.checkpoints.list(id),
        evidence,
      };
    },
  );
  register(
    'searchMessages',
    operation('会话', 'query', '全文检索会话消息；返回来源 ID、摘要和下一页 seq', [
      z.string().max(500),
      session.optional(),
      z.number().int().positive().optional(),
    ]),
    (q, id, before) =>
      store.searchMessages(
        z.string().max(500).parse(q),
        idSchema.optional().parse(id),
        undefined,
        z.number().int().positive().optional().parse(before),
      ),
  );
  register(
    'historyMessage',
    operation('会话', 'query', '读取检索命中的完整消息片段', [
      session,
      z.string().min(1),
      z.number().int().min(0).optional(),
    ]),
    (id, messageId, offset) =>
      store.readMessage(
        idSchema.parse(id),
        z.string().parse(messageId),
        z.number().int().min(0).default(0).parse(offset),
        8000,
      ),
  );
  register(
    'resumeTask',
    operation(
      '任务与终端',
      'change',
      '核对已完成的操作和未知结果后，在新轮次继续中断任务',
      [session],
      {
        guard: (args, current) => {
          if (args[0] === current) throw new Error('请用输入框继续当前任务');
        },
      },
    ),
    (id) => {
      const s = store.get<Session>('session', idSchema.parse(id));
      const last = store.sessionObjects<Run>('run', s.id, 1)[0];
      if (!last || !['failed', 'interrupted'].includes(last.status))
        throw new Error('此会话没有待恢复的中断任务');
      return runtime.start({
        sessionId: s.id,
        providerId: s.providerId,
        model: s.model,
        agentId: s.agentId,
        prompt:
          '继续上次未完成的任务。先读取任务记忆、最后的工具结果、工作区变更与持久终端状态，核对已完成和结果未知的操作。不要盲目重放写入、推送、发送等操作。保留用户中途约束，从尚未完成的步骤继续，最后用真实验证结果说明完成情况。',
      });
    },
  );
  register(
    'startTerminal',
    operation('任务与终端', 'change', '在项目目录或普通会话独立工作目录中创建持久交互终端', [
      session,
    ]),
    (id) => runtime.terminals.start(idSchema.parse(id)),
  );
  register(
    'readTerminal',
    operation('任务与终端', 'query', '分段读取本会话的终端日志', [
      session,
      terminal,
      z.number().int().min(0).optional(),
    ]),
    (id, t, offset) =>
      runtime.terminals.read(
        idSchema.parse(id),
        idSchema.parse(t),
        z.number().int().min(0).default(0).parse(offset),
      ),
  );
  register(
    'writeTerminal',
    operation('任务与终端', 'change', '向指定会话终端输入文字或控制键', [
      session,
      terminal,
      z.string().max(16000),
    ]),
    (id, t, text) =>
      runtime.terminals.write(
        idSchema.parse(id),
        idSchema.parse(t),
        z.string().max(16000).parse(text),
      ),
  );
  register(
    'resizeTerminal',
    manual('任务与终端', '调整终端显示尺寸', 'workspace', '终端显示尺寸由界面决定', [
      session,
      terminal,
      z.number().int().min(20).max(500),
      z.number().int().min(5).max(200),
    ]),
    (id, t, cols, rows) =>
      runtime.terminals.resize(
        idSchema.parse(id),
        idSchema.parse(t),
        z.number().int().min(20).max(500).parse(cols),
        z.number().int().min(5).max(200).parse(rows),
      ),
  );
  register(
    'stopTerminal',
    operation('任务与终端', 'change', '停止指定会话的持久终端', [session, terminal]),
    (id, t) => runtime.terminals.stop(idSchema.parse(id), idSchema.parse(t)),
  );
  register(
    'runPatch',
    operation('改动与交付', 'query', '查看指定轮次前后文本差异', [idSchema, z.string().max(2000)]),
    (id, file) => runtime.checkpoints.patch(idSchema.parse(id), z.string().max(2000).parse(file)),
  );
  register(
    'restoreRunFile',
    operation('改动与交付', 'change', '恢复文件到本轮开始前；文件后续已变更时拒绝覆盖', [
      idSchema,
      z.string().max(2000),
    ]),
    (id, file) => {
      checkpointIdle(idSchema.parse(id));
      return runtime.checkpoints.restore(id, z.string().max(2000).parse(file));
    },
  );
  register(
    'stageRunFile',
    operation('改动与交付', 'change', '将已审阅且内容未变化的文件暂存到 Git', [
      idSchema,
      z.string().max(2000),
    ]),
    (id, file) => {
      checkpointIdle(idSchema.parse(id));
      return runtime.checkpoints.stage(id, z.string().max(2000).parse(file));
    },
  );
  register(
    'reviewStaged',
    operation('改动与交付', 'query', '读取完整已暂存差异及指纹，提交时必须携带指纹', [idSchema]),
    (id) => runtime.checkpoints.staged(idSchema.parse(id)),
  );
  register(
    'commitStaged',
    operation(
      '改动与交付',
      'change',
      '提交项目当前全部已暂存内容；先用 reviewStaged 审阅，传回相同 hash',
      [idSchema, z.string().trim().min(1).max(2000), z.string().regex(/^[a-f0-9]{64}$/)],
    ),
    (id, message, expected) => {
      idle(idSchema.parse(id));
      return runtime.checkpoints.commit(
        id,
        z.string().trim().min(1).max(2000).parse(message),
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(expected),
      );
    },
  );
  const maintenance = new DataMaintenance(store, dataDir),
    password = z.string().min(12).max(256);
  register(
    'backupWorkspace',
    manual(
      '数据维护',
      '导出加密工作数据备份',
      'settings',
      '用户设置备份密码并选择保存位置；不导出登录凭据',
      [password],
    ),
    async (raw) => {
      idle();
      const pass = password.parse(raw);
      const file = await dialog.showSaveDialog({
        title: '保存加密备份',
        defaultPath: '同舟工作数据.tzbackup',
        filters: [{ name: '同舟加密备份', extensions: ['tzbackup'] }],
      });
      if (file.canceled || !file.filePath) return null;
      await writeFile(file.filePath, maintenance.backup(pass));
      return file.filePath;
    },
  );
  register(
    'restoreWorkspace',
    manual(
      '数据维护',
      '导入备份并重启，原有工作数据保留为回退副本',
      'settings',
      '用户确认替换工作数据，输入备份密码并选择文件',
      [password],
    ),
    async (raw) => {
      idle();
      const pass = password.parse(raw);
      const choice = await dialog.showOpenDialog({
        title: '选择加密备份',
        properties: ['openFile'],
        filters: [{ name: '同舟加密备份', extensions: ['tzbackup'] }],
      });
      if (choice.canceled) return null;
      const file = choice.filePaths[0];
      if ((await stat(file)).size > 256 * 1024 * 1024) throw new Error('备份超过 256 MB');
      maintenance.prepareRestore(await readFile(file), pass);
      app.relaunch();
      app.quit();
      return '恢复已准备，正在重启';
    },
  );
  register(
    'exportDiagnostics',
    manual(
      '数据维护',
      '导出不含消息、文件、账号与凭据的诊断包',
      'settings',
      '用户选择导出位置',
      [],
    ),
    async () => {
      const file = await dialog.showSaveDialog({
        title: '导出脱敏诊断',
        defaultPath: 'tongzhou-diagnostics.json',
      });
      if (file.canceled || !file.filePath) return null;
      await writeFile(
        file.filePath,
        JSON.stringify(maintenance.diagnostics(app.getVersion()), null, 2),
      );
      return file.filePath;
    },
  );
  register(
    'cleanUnusedData',
    manual(
      '数据维护',
      '清理无注册记录的孤立附件和未引用检查点内容',
      'settings',
      '用户主动清理本地数据',
      [],
    ),
    () => {
      idle();
      return maintenance.cleanUnused();
    },
  );
  register(
    'checkRelease',
    operation('数据维护', 'query', '查询 GitHub 正式发布版本；不下载安装', []),
    async () => {
      const r = await serviceFetch(
        'https://api.github.com/repos/OrenZhang/tongzhou/releases/latest',
        { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) },
      );
      if (r.status === 404)
        return {
          current: app.getVersion(),
          latest: null,
          url: 'https://github.com/OrenZhang/tongzhou/releases',
        };
      if (!r.ok) throw new Error('检查版本失败：HTTP ' + r.status);
      const data: any = await r.json();
      return {
        current: app.getVersion(),
        latest: String(data.tag_name).slice(0, 100),
        url: 'https://github.com/OrenZhang/tongzhou/releases',
      };
    },
  );
}
