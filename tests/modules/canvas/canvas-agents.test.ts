import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../electron/services/storage/store';
import { createDomainServices } from '../../../electron/modules/domain-services';
import { ensureBuiltinSkills } from '../../../electron/modules/plugins/skills';
import { agentProfile } from '../../../electron/modules/agents/agents';
import { ToolScope } from '../../../electron/core/tools/extensions';
import { attachCanvasTools } from '../../../electron/modules/canvas/canvas-tools';
import { emptyWhiteboard } from '../../../src/shared/whiteboard';
import { canvasAgentId } from '../../../src/shared/builtin-agents';
import type { Session, SkillRecord } from '../../../src/shared/types';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
it('switches session agent, skill resources and graph tools on workflow/whiteboard binding without changing permissions', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cosail-canvas-agents-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  cleanups.push(() => store.close());
  const domains = createDomainServices(store, root);
  ensureBuiltinSkills(store, path.resolve('skills'));
  const session = store.createSession();
  store.setSessionPermission(session.id, 'read-only');
  for (const mode of ['workflow', 'whiteboard', 'workflow'] as const) {
    const canvas = domains.canvases.save({
      title: mode,
      mode,
      ...(mode === 'whiteboard' ? { whiteboard: emptyWhiteboard() } : {}),
      nodes: [],
      edges: [],
      selection: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    domains.canvases.bind(session.id, canvas.id);
    const current = store.get<Session>('session', session.id);
    expect(current.agentId).toBe(canvasAgentId(mode));
    expect(current.permission).toBe('read-only');
    const agent = agentProfile(store, current.agentId);
    expect(agent.skillIds).toHaveLength(1);
    const skill = store.get<SkillRecord>('skill', agent.skillIds![0]);
    expect(skill.enabled).toBe(true);
    // Every local reference is actually packaged and parseable, not a dangling document link.
    for (const match of skill.instructions.matchAll(/\]\((references\/[^)]+)\)/g))
      expect(skill.files[match[1]], match[1]).toBeTruthy();
    const scope = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    cleanups.push(() => scope.close());
    scope.prepareSkills(store);
    attachCanvasTools(
      scope,
      store,
      domains.canvases,
      domains.canvasWorkflows,
      current,
      false,
      () => {},
    );
    expect(scope.has('canvas_apply')).toBe(mode === 'workflow');
    expect(scope.has('canvas_execute')).toBe(mode === 'workflow');
    expect(scope.has('whiteboard_apply')).toBe(mode === 'whiteboard');
    const loaded = await scope.call('read_skill_file', { skillId: skill.id, path: 'SKILL.md' });
    expect(loaded.text).toBe(skill.instructions);
    if (mode === 'whiteboard') {
      const reference = await scope.call('read_skill_file', {
        skillId: skill.id,
        path: 'references/operations.md',
      });
      const example = JSON.parse(reference.text!.match(/```json\n([\s\S]*?)\n```/)![1]);
      const result = JSON.parse(
        (await scope.call('whiteboard_apply', { version: canvas.version, ops: example })).text!,
      );
      expect(result.connections).toMatchObject([{ from: 'start', to: 'check', bound: true }]);
    }
  }
  domains.canvases.bind(session.id, null);
  expect(store.get<Session>('session', session.id).agentId).toBe('');
});
