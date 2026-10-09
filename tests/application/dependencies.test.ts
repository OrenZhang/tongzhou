import { describe, expect, it } from 'vitest';
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
            reference,
          )
        )
          violations.push(`${file} -> ${reference}`);
    expect(violations).toEqual([]);
  });
  it('keeps contracts and the Cordis service registry independent of concrete task and engine implementations', async () => {
    for (const file of [
      'electron/core/task-contracts.ts',
      'electron/application/context.ts',
      'electron/core/runtime/task-scheduler.ts',
    ]) {
      const references = await imports(file);
      expect(
        references.filter((reference) =>
          /\/core\/codex\/(codex|execution|codex-sessions)$/.test(reference),
        ),
        file,
      ).toEqual([]);
      if (!file.endsWith('task-scheduler.ts'))
        expect(
          references.filter((reference) =>
            /\/(task-scheduler|task-system|runtime)$/.test(reference),
          ),
          file,
        ).toEqual([]);
    }
  });
});
