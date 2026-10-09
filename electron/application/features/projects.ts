import { dialog, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Project, Session } from '../../../src/shared/types';
import { manual, operation, workspaceOperation } from '../../core/tools/client-commands';
import { command, files, read } from '../../core/tools/workspace';
import {
  projectChanges,
  projectInstructionsView,
  projectPatch,
  projectSearch,
} from '../../modules/projects/project-context';
import { initializeAgent } from '../../modules/projects/project-init';
import { absolutePathSchema } from '../../services/storage/file-transfer';
import { idSchema } from '../../services/storage/validation';
import type { Plugin } from 'cordis';
import '../context';

export const projectsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-projects',
  inject: [
    'tzIpc',
    'tzStore',
    'tzRuntime',
    'tzSessions',
    'tzChannels',
    'tzFeishu',
    'tzDesktop',
    'tzProjectTools',
  ],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = ctx.tzRuntime;
    const channels = ctx.tzChannels;
    const feishu = ctx.tzFeishu;
    const { getWindow } = ctx.tzDesktop;
    const { worktrees, repositories, activity: worktreeActivity } = ctx.tzProjectTools;
    register(
      'projectDeletionPreview',
      operation('项目与 Git', 'query', '核对项目内全部会话（包含归档与子会话）', [idSchema]),
      (id) => ctx.tzSessions.projectDeletionPreview(idSchema.parse(id)),
    );
    register(
      'listWorktrees',
      operation('项目与 Git', 'query', '列出项目及其工作树', [idSchema.describe('projectId')]),
      (id) => worktrees.list(idSchema.parse(id)),
    );
    register(
      'createWorktree',
      operation('项目与 Git', 'change', '为项目创建隔离工作树，返回目录和项目 ID', [
        idSchema.describe('projectId'),
        z.string().min(1).describe('branch'),
        z.string().min(1).describe('ref，如 HEAD'),
      ]),
      async (id, branch, ref) => {
        worktreeActivity.count++;
        try {
          return await worktrees.create(idSchema.parse(id), branch, ref);
        } finally {
          worktreeActivity.count--;
        }
      },
    );
    register(
      'removeWorktree',
      operation(
        '项目与 Git',
        'change',
        '移除同舟创建且无未保存或未推送更改的工作树',
        [idSchema.describe('worktreeProjectId')],
        { confirmation: 'always' },
      ),
      async (id) => {
        worktreeActivity.count++;
        try {
          return await worktrees.remove(idSchema.parse(id));
        } finally {
          worktreeActivity.count--;
        }
      },
    );
    register(
      'openProjectFolder',
      operation('项目与 Git', 'change', '在系统文件管理器打开项目目录', [
        idSchema.describe('projectId'),
      ]),
      async (id) => {
        const p = store.get<Project>('project', idSchema.parse(id));
        if (p.removed) throw new Error('工作树已移除');
        const error = await shell.openPath(p.path);
        if (error) throw new Error('无法打开此项目目录');
      },
    );
    register(
      'gitRepository',
      operation('项目与 Git', 'query', '查询 Git 分支、状态和远程信息', [
        idSchema.describe('projectId'),
      ]),
      (id) => repositories.info(idSchema.parse(id)),
    );
    register(
      'bindGitAccount',
      operation('项目与 Git', 'change', '绑定已有代码托管账号，空字符串解绑', [
        idSchema.describe('projectId'),
        z.string().describe('connectorId'),
      ]),
      (id, connectorId) => repositories.bind(idSchema.parse(id), z.string().parse(connectorId)),
    );
    register(
      'syncRepository',
      operation('项目与 Git', 'change', '拉取或推送项目代码', [
        idSchema.describe('projectId'),
        z.enum(['pull', 'push']),
      ]),
      (id, action) => repositories.sync(idSchema.parse(id), z.enum(['pull', 'push']).parse(action)),
    );
    register(
      'cloneRepository',
      operation('项目与 Git', 'change', '使用已有账号克隆仓库到本地新目录', [
        idSchema.describe('connectorId'),
        z.string().url().describe('repositoryUrl'),
        z.string().min(1).describe('absoluteDirectory'),
      ]),
      (id, url, directory) => repositories.clone(idSchema.parse(id), url, directory),
    );
    register(
      'chooseCloneDirectory',
      manual(
        '项目与 Git',
        '选择克隆目标目录',
        'workspace',
        '需要用户在系统文件夹选择器中选择目录',
        [],
      ),
      async () => {
        const result = await dialog.showOpenDialog(getWindow()!, {
          title: '选择克隆到的父目录',
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
      },
    );
    register(
      'initializeAgent',
      operation('项目与 Git', 'change', '为项目生成 agent.md 初始化说明，已有说明不覆盖', [
        idSchema.describe('projectId'),
      ]),
      (id) => initializeAgent(store.get<Project>('project', idSchema.parse(id)).path),
    );
    register(
      'addProject',
      workspaceOperation(
        store,
        '项目与 Git',
        'change',
        '打开已有项目；指定绝对目录直接添加，省略则选择目录',
        [absolutePathSchema.optional()],
      ),
      async (directory) => {
        const result = directory
          ? { canceled: false, filePaths: [absolutePathSchema.parse(directory)] }
          : await dialog.showOpenDialog(getWindow()!, {
              title: '选择项目目录',
              properties: ['openDirectory'],
            });
        if (result.canceled) return null;
        const selected = await realpath(result.filePaths[0]);
        if (!(await stat(selected)).isDirectory()) throw new Error('请选择目录');
        const previous = store.list<Project>('project').find((p) => p.path === selected);
        if (previous) return previous;
        const project = store.put('project', {
          id: randomUUID(),
          name: path.basename(selected),
          path: selected,
          createdAt: Date.now(),
        });
        runtime.changed();
        return project;
      },
    );
    register(
      'deleteProject',
      workspaceOperation(
        store,
        '项目与 Git',
        'change',
        '删除项目及关联会话，保留磁盘文件',
        [idSchema.describe('projectId'), z.array(idSchema).optional()],
        {
          confirmation: 'always',
          guard: ([id], current) => {
            if (store.get<Session>('session', current).projectId === id)
              throw new Error('不能从项目自身的运行会话删除该项目，请在普通会话操作');
          },
        },
      ),
      (id, expectedSessionIds) => {
        if (worktreeActivity.count) throw new Error('正在处理工作树，请完成后再删除项目。');
        const deleted = ctx.tzSessions.deleteProject(
          idSchema.parse(id),
          z.array(idSchema).optional().parse(expectedSessionIds),
        );
        for (const sessionId of deleted) channels.abort(sessionId);
        feishu.sync();
        return deleted;
      },
    );
    register(
      'listFiles',
      operation('项目与 Git', 'query', '列出项目相对目录的文件', [
        idSchema.describe('projectId'),
        z.string().max(1000).describe('relativePath，根目录用空字符串'),
      ]),
      (id, relative) =>
        files(
          store.get<Project>('project', idSchema.parse(id)).path,
          z.string().max(1000).parse(relative),
        ),
    );
    register(
      'readFile',
      operation('项目与 Git', 'query', '读取项目相对路径文件', [
        idSchema.describe('projectId'),
        z.string().max(1000).describe('relativePath'),
      ]),
      (id, relative) =>
        read(
          store.get<Project>('project', idSchema.parse(id)).path,
          z.string().max(1000).parse(relative),
        ),
    );
    register(
      'diff',
      operation('项目与 Git', 'query', '查询项目 Git 状态和更改差异', [
        idSchema.describe('projectId'),
      ]),
      async (id) => {
        const root = store.get<Project>('project', idSchema.parse(id)).path;
        const signal = AbortSignal.timeout(15000);
        const status = await command('git', ['status', '--short'], root, signal);
        const diff = await command(
          'git',
          ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'],
          root,
          signal,
        );
        return status + '\n\n' + diff;
      },
    );
    const changeScope = z.enum(['unstaged', 'staged']);
    const projectRoot = (id: unknown) => store.get<Project>('project', idSchema.parse(id)).path;
    register(
      'projectChanges',
      operation('项目与 Git', 'query', '按未暂存或已暂存范围查询结构化变更，包含未跟踪文件', [
        idSchema.describe('projectId'),
        changeScope,
      ]),
      (id, scope) => projectChanges(projectRoot(id), changeScope.parse(scope)),
    );
    register(
      'projectPatch',
      operation('项目与 Git', 'query', '读取单个文件的 Git 差异', [
        idSchema.describe('projectId'),
        z.string().min(1).max(1000).describe('relativePath'),
        changeScope,
      ]),
      (id, relative, scope) =>
        projectPatch(
          projectRoot(id),
          z.string().min(1).max(1000).parse(relative),
          changeScope.parse(scope),
        ),
    );
    register(
      'projectSearch',
      operation('项目与 Git', 'query', '按文件路径或文本内容搜索项目，遵循忽略规则', [
        idSchema.describe('projectId'),
        z.string().trim().min(1).max(500).describe('query'),
        z.enum(['path', 'content']),
      ]),
      (id, query, mode) =>
        projectSearch(
          projectRoot(id),
          z.string().trim().min(1).max(500).parse(query),
          z.enum(['path', 'content']).parse(mode),
        ),
    );
    register(
      'projectInstructions',
      operation('项目与 Git', 'query', '查看项目根目录现有 AGENTS.md、agent.md 和 README', [
        idSchema.describe('projectId'),
      ]),
      (id) => projectInstructionsView(projectRoot(id)),
    );
  },
};
