import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionApplication } from '../../electron/application/execution-application';
import type { ExecutionEnvironment } from '../../electron/application/execution-context';
import { localSecretCodec } from '../../electron/services/storage/local-secret-codec';
import { writeLocalFile } from '../../electron/services/storage/file-transfer';
import type { Store } from '../../electron/services/storage/store';
import type { Run, Session, PluginConfig, SkillRecord } from '../../src/shared/types';
import { builtinSkills } from '../../src/shared/builtin-skills';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function call(id: string, name: string, args: unknown) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}
const reply = (content: string) => ({
  choices: [{ delta: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 5 },
});
const receipt = (body: any) =>
  JSON.parse(body.messages.findLast((m: any) => m.role === 'tool').content);

describe('work delivery through the production application and Codex loop', () => {
  it('repairs code after a failed check, delivers through client discovery, and resumes from task memory', async () => {
    await mkdir(path.resolve('test-results'), { recursive: true });
    const root = await mkdtemp(path.resolve('test-results/work-capabilities-'));
    cleanups.push(() =>
      rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    );
    // npm test precedes the production build in CI. This fixture must not use dist-electron.
    // Keeping it under the checkout lets createRequire resolve installed packages normally,
    // including on Windows, without junctions or symlinks. No bundled helper is invoked here.
    const bundleDir = path.join(root, 'bundle');
    for (const skill of builtinSkills)
      await cp(
        path.resolve('skills', skill.directory),
        path.join(bundleDir, 'skills', skill.directory),
        {
          recursive: true,
        },
      );
    const project = path.join(root, 'project with spaces');
    await mkdir(project);
    const base = 'exports.clamp = (n) => n;\n';
    const userEdits =
      '// User change: preserve this note and label.\nexports.label = "用户自定义";\n';
    const initial = base + userEdits;
    const check = [
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "const {clamp, label} = require('./clamp.cjs');",
      "fs.appendFileSync('verification.log', 'check\\n');",
      "assert.equal(label, '用户自定义');",
      "assert.equal(fs.readFileSync('notes.txt', 'utf8'), 'Existing user notes');",
      "assert.ok(fs.readFileSync('clamp.cjs', 'utf8').includes('// User change: preserve this note and label.'));",
      'assert.equal(clamp(-2), 0);',
      'assert.equal(clamp(5), 5);',
      'assert.equal(clamp(12), 10);',
      "console.log('Boundary checks and user changes verified');",
    ].join('\n');
    await writeFile(path.join(project, 'clamp.cjs'), base);
    await writeFile(path.join(project, 'notes.txt'), 'Existing user notes');
    await writeFile(path.join(project, 'verify.cjs'), check);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
        cwd: project,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    git('init');
    git('add', '.');
    // This commit exists only in the disposable fixture, never in the application repository.
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture baseline',
    );
    await writeFile(path.join(project, 'clamp.cjs'), initial);
    expect(git('diff')).toContain('User change');

    const requests: any[] = [];
    const modelErrors: unknown[] = [];
    let phase: 'work' | 'resume' | 'document' = 'work';
    let round = 0;
    let documentId = '';
    let foreignId = '';
    let method = '';
    const delivery =
      '# 编码交付\n\nclamp 已覆盖上下界，保留用户的 label、注释与笔记。node verify.cjs 已通过。';
    const model = (body: any) => {
      round++;
      const names = body.tools?.map((t: any) => t.function?.name ?? t.name) ?? [];
      if (phase === 'document') {
        expect(names).toContain('content_read');
        expect(names).not.toContain('client_catalog');
        expect(names).not.toContain('client_change');
        expect(names).not.toContain('run_command');
        expect(names).not.toContain('apply_edit');
        if (round === 1) return call('blocked-library', 'content_read', { id: foreignId });
        expect(JSON.stringify(body.messages)).toContain('文档不在当前内容范围');
        return reply('文档任务保持当前内容范围。');
      }
      if (phase === 'resume') {
        if (round === 1) return call('resume-memory', 'task_memory', { action: 'read' });
        if (round === 2) {
          expect(receipt(body)).toMatchObject({
            goal: '修复 clamp 并入库交付说明',
            completed: expect.arrayContaining([`交付文档 ${documentId}`]),
          });
          return call('resume-content', 'content_read', { id: documentId });
        }
        expect(receipt(body)).toMatchObject({ id: documentId, version: 1, content: delivery });
        return reply('已从交接记忆和内容库核对交付，没有重复写入。');
      }
      switch (round) {
        case 1:
          expect(names).toEqual(
            expect.arrayContaining([
              'read_range',
              'apply_edit',
              'completion_check',
              'client_catalog',
              'client_change',
              'content_read',
              'task_memory',
            ]),
          );
          return call('read-initial', 'read_range', { path: 'clamp.cjs' });
        case 2:
          expect(receipt(body).content).toContain('用户自定义');
          return call('partial-fix', 'apply_edit', {
            path: 'clamp.cjs',
            expectedHash: receipt(body).sha256,
            oldText: '(n) => n;',
            newText: '(n) => Math.max(0, n);',
          });
        case 3:
          return call('register-check', 'completion_check', {
            checks: [
              {
                command: 'node verify.cjs',
                description: '上下界、原有正常输入及用户修改均保持正确',
              },
            ],
          });
        case 4:
          return reply('初次修复完成，等待检查。');
        case 5:
          expect(JSON.stringify(body.messages)).toContain('完成检查未通过');
          expect(JSON.stringify(body.messages)).toContain('exitCode');
          return call('read-after-check', 'read_range', { path: 'clamp.cjs' });
        case 6:
          return call('complete-fix', 'apply_edit', {
            path: 'clamp.cjs',
            expectedHash: receipt(body).sha256,
            oldText: 'Math.max(0, n)',
            newText: 'Math.min(10, Math.max(0, n))',
          });
        case 7:
          return call('verify-repair', 'run_command', { command: 'node verify.cjs' });
        case 8:
          expect(receipt(body)).toMatchObject({ exitCode: 0, status: 'completed' });
          expect(receipt(body).output).toContain('user changes verified');
          return call('find-delivery', 'client_catalog', { query: 'contentWrite', limit: 1 });
        case 9: {
          const catalog = receipt(body);
          expect(catalog.total).toBe(1);
          expect(catalog.methods[0]).toMatchObject({ name: 'contentWrite', available: true });
          method = catalog.methods[0].name;
          return call('delivery-schema', 'client_catalog', { method });
        }
        case 10:
          expect(JSON.stringify(receipt(body).methods[0].arguments)).toContain('libraryId');
          return call('persist-delivery', 'client_change', {
            method,
            argsJson: JSON.stringify([
              { libraryId: 'default', title: 'clamp 交付说明', content: delivery },
            ]),
          });
        case 11: {
          const saved = receipt(body);
          expect(saved.persisted).toBe(true);
          expect(saved.totalChars).toBe(delivery.length);
          documentId = saved.id;
          return call('read-delivery', 'content_read', { id: documentId });
        }
        case 12:
          expect(receipt(body)).toMatchObject({ id: documentId, content: delivery, version: 1 });
          return call('save-handoff', 'task_memory', {
            action: 'write',
            memory: {
              goal: '修复 clamp 并入库交付说明',
              constraints: ['保留用户已有修改与笔记'],
              decisions: ['沿用现有模块'],
              completed: ['node verify.cjs 已通过', `交付文档 ${documentId}`],
              nextSteps: ['后续仅核对记录，不重复写入'],
              sources: [],
            },
          });
        case 13:
          expect(receipt(body).completed).toContain(`交付文档 ${documentId}`);
          return reply('修复、验证、交付入库及交接记忆均已完成。');
        default:
          throw new Error(`Unexpected model request ${phase}:${round}`);
      }
    };
    const unavailable = async () => {
      throw new Error('Native UI is unavailable in this fixture');
    };
    const profile = path.join(root, 'profile');
    const environment: ExecutionEnvironment = {
      dataDir: profile,
      bundleDir,
      createSecretCodec: () => localSecretCodec(profile),
      emit: () => {},
      host: {
        version: 'fixture',
        documents: {
          chooseFiles: unavailable,
          readImport: readFile,
          saveCopy: unavailable,
          writeTo: writeLocalFile,
          openPath: unavailable,
          openExternal: unavailable,
        },
        dialogs: { showOpenDialog: unavailable, showSaveDialog: unavailable },
        writeClipboard: unavailable,
        restart: unavailable,
      },
      modelTransport: async () => async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({ phase, body });
        let event;
        try {
          event = model(body);
        } catch (error) {
          modelErrors.push(error);
          // A final response lets the real engine drain; assertions below report the exact failure.
          event = reply('Fixture assertion failed.');
        }
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    };
    const app = new ExecutionApplication(environment);
    cleanups.push(() => app.stop());
    await app.start();
    const store = app.kernel.get<Store>('tzStore');
    // No optional plugins, background model jobs, network accounts, or user profile enter this test.
    for (const plugin of store.list<PluginConfig>('plugin'))
      store.put('plugin', { ...plugin, enabled: false });
    for (const skill of store.list<SkillRecord>('skill'))
      store.put('skill', { ...skill, enabled: false });
    app.kernel.context.tzKnowledge.configure({ autoCollect: false });
    store.saveProvider({
      id: 'fixture',
      name: 'Fixture',
      protocol: 'openai-chat',
      baseUrl: 'https://unused.invalid/v1',
      auth: 'none',
      models: ['mock'],
      maxOutputTokens: 8192,
      contextChars: 0,
    });
    store.put('project', {
      id: 'fixture-project',
      name: 'Fixture project',
      path: project,
      createdAt: Date.now(),
    });
    const session = app.client.invoke('createSession', 'fixture-project') as Session;
    app.client.invoke('setSessionPermission', session.id, 'full-access');
    const input = {
      sessionId: session.id,
      providerId: 'fixture',
      model: 'mock',
      agentId: '',
      prompt:
        '修复 clamp 的上下界，保留已有用户修改。运行现有 verify.cjs 检查，失败后继续修复；通过客户端能力目录保存交付说明到内容库，读回核验，再保存任务交接记忆。',
    };
    const id = app.client.invoke('run', input) as string;
    await app.tasks.waitForIdle();
    expect(modelErrors).toEqual([]);
    const run = store.get<Run>('run', id);
    expect(run).toMatchObject({
      status: 'completed',
      completionChecks: { attempts: 2, checks: [{ status: 'passed' }] },
    });
    expect(requests.filter((r) => r.phase === 'work')).toHaveLength(13);
    expect(await readFile(path.join(project, 'clamp.cjs'), 'utf8')).toBe(
      'exports.clamp = (n) => Math.min(10, Math.max(0, n));\n' + userEdits,
    );
    expect(await readFile(path.join(project, 'notes.txt'), 'utf8')).toBe('Existing user notes');
    expect(await readFile(path.join(project, 'verify.cjs'), 'utf8')).toBe(check);
    expect(
      (await readFile(path.join(project, 'verification.log'), 'utf8')).trim().split('\n'),
    ).toHaveLength(3);
    const docs = app.kernel.context.tzKnowledge.all();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: documentId,
      version: 1,
      content: delivery,
      projectId: 'fixture-project',
    });
    expect(
      await readFile(app.kernel.context.tzKnowledge.documents.file(documentId), 'utf8'),
    ).toContain(delivery);
    const records = store.messages(session.id);
    expect(records.find((m) => m.content === '初次修复完成，等待检查。')?.phase).toBe('commentary');
    expect(records.filter((m) => m.role === 'tool' && m.toolName === 'client_change')).toHaveLength(
      1,
    );
    expect(records.filter((m) => m.role === 'tool' && m.toolName === 'apply_edit')).toHaveLength(2);
    const segment = store.get<any>('engineSegment', id);
    expect(segment).toMatchObject({ completed: true, sessionId: session.id });
    expect(segment.threadId).toBeTruthy();

    phase = 'resume';
    round = 0;
    const nextId = app.client.invoke('run', {
      ...input,
      prompt: '继续：读取交接记忆，再核对已入库说明，不重复修改。',
    }) as string;
    await app.tasks.waitForIdle();
    expect(modelErrors).toEqual([]);
    expect(store.get<Run>('run', nextId).status).toBe('completed');
    expect(store.get<any>('engineSegment', nextId).threadId).toBe(segment.threadId);
    expect(app.kernel.context.tzKnowledge.get(documentId).version).toBe(1);
    expect(app.kernel.context.tzKnowledge.all()).toHaveLength(1);
    expect(
      store.messages(session.id).filter((m) => m.role === 'tool' && m.toolName === 'client_change'),
    ).toHaveLength(1);

    const otherLibrary = app.client.invoke('contentLibrarySave', { name: '另一个内容库' }) as {
      id: string;
    };
    const foreign = app.client.invoke('contentWrite', {
      libraryId: otherLibrary.id,
      title: '不属于当前文档任务',
      content: 'FOREIGN_LIBRARY_SENTINEL',
    }) as { id: string };
    foreignId = foreign.id;
    phase = 'document';
    round = 0;
    const background = app.client.invoke('contentRun', {
      documentId,
      version: 1,
      providerId: 'fixture',
      model: 'mock',
      prompt: '核对当前交付说明。',
    }) as { runId: string; sessionId: string };
    await app.tasks.waitForIdle();
    expect(modelErrors).toEqual([]);
    expect(store.get<Run>('run', background.runId).status).toBe('completed');
    expect(JSON.stringify(requests.filter((r) => r.phase === 'document'))).not.toContain(
      'FOREIGN_LIBRARY_SENTINEL',
    );
    expect(app.kernel.context.tzKnowledge.get(documentId).version).toBe(1);
    expect(app.kernel.context.tzKnowledge.get(foreignId).version).toBe(1);
  }, 90000);
});
