import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

async function files(root: string): Promise<string[]> {
  return (
    await Promise.all(
      (await readdir(root, { withFileTypes: true })).map((entry) => {
        const file = path.join(root, entry.name);
        return entry.isDirectory()
          ? files(file)
          : Promise.resolve(file.endsWith('.ts') ? [file] : []);
      }),
    )
  ).flat();
}
async function imports(file: string) {
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const references: string[] = [];
  const visit = (node: ts.Node) => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
    if (specifier && ts.isStringLiteral(specifier))
      references.push(
        specifier.text.startsWith('.')
          ? path.resolve(path.dirname(file), specifier.text)
          : specifier.text,
      );
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}
describe('architectural dependency boundaries', () => {
  it.each(['C:\\repo\\electron\\core\\codex\\execution', '/repo/electron/core/codex/execution'])(
    'detects forbidden engine imports on either platform: %s',
    (reference) => {
      expect(
        /\/core\/codex\/(codex|execution|codex-sessions)$/.test(reference.replaceAll('\\', '/')),
      ).toBe(true);
    },
  );
  it('keeps the transitive execution entry independent of Electron, including its contracts', async () => {
    const pending = [path.resolve('electron/application/execution-application.ts')];
    const visited = new Set<string>();
    const violations: string[] = [];
    while (pending.length) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const reference of await imports(file)) {
        if (/^(electron|electron-updater)(\/|$)/.test(reference))
          violations.push(`${path.relative(process.cwd(), file)} -> ${reference}`);
        if (path.isAbsolute(reference)) {
          const target = [reference + '.ts', path.join(reference, 'index.ts')].find(existsSync);
          if (target) pending.push(target);
        }
      }
    }
    expect(visited.size).toBeGreaterThan(100);
    expect(violations).toEqual([]);
  });
  it('keeps business modules and channels independent of the concrete scheduler and Codex engine', async () => {
    const sources = [
      ...(await files('electron/modules')),
      ...(await files('electron/services/channels')),
    ];
    const violations: string[] = [];
    for (const file of sources)
      for (const reference of await imports(file))
        if (
          /\/core\/(runtime\/(runtime|task-scheduler|codex-execution)|codex\/(codex|execution))$/.test(
            reference.replaceAll('\\', '/'),
          )
        )
          violations.push(`${file} -> ${reference}`);
    expect(violations).toEqual([]);
  });
  it('keeps contracts and the Cordis service registry independent of concrete task and engine implementations', async () => {
    for (const file of [
      'electron/core/task-contracts.ts',
      'electron/application/context.ts',
      'electron/application/execution-context.ts',
      'electron/core/runtime/task-scheduler.ts',
    ]) {
      const references = await imports(file);
      expect(
        references.filter((reference) =>
          /\/core\/codex\/(codex|execution|codex-sessions)$/.test(reference.replaceAll('\\', '/')),
        ),
        file,
      ).toEqual([]);
      if (!file.endsWith('task-scheduler.ts'))
        expect(
          references.filter((reference) =>
            /\/(task-scheduler|task-system|runtime)$/.test(reference.replaceAll('\\', '/')),
          ),
          file,
        ).toEqual([]);
    }
  });
});
