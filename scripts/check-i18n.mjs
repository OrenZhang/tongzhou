import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const english = JSON.parse(fs.readFileSync('src/shared/locales/en.json', 'utf8'));
const missing = [];
function inspect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      inspect(file);
      continue;
    }
    if (!/\.tsx?$/.test(file)) continue;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['tr', 't'].includes(node.expression.text)
      ) {
        const arg = node.arguments[0];
        if (
          arg &&
          ts.isStringLiteralLike(arg) &&
          /[\u3400-\u9fff]/.test(arg.text) &&
          !(arg.text in english)
        ) {
          missing.push(
            `${file}:${source.getLineAndCharacterOfPosition(arg.getStart()).line + 1}: ${arg.text}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
inspect('src');
if (missing.length) {
  console.error(missing.join('\n'));
  process.exitCode = 1;
} else console.log(`UI translation coverage passed (${Object.keys(english).length} entries).`);
