import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Seed an isolated profile before Electron starts, including existing Agent documents. */
export async function seedKnowledge(profile, seed) {
  const outfile = path.join(profile, 'knowledge-fixture.cjs');
  await build({
    stdin: {
      contents:
        "export { Store } from './electron/services/storage/store'; export { Knowledge } from './electron/modules/knowledge/knowledge';",
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile,
  });
  const { Store, Knowledge } = createRequire(import.meta.url)(outfile);
  const store = new Store(path.join(profile, 'tongzhou.db'), {
    encrypt: (s) => s,
    decrypt: (s) => s,
  });
  const knowledge = new Knowledge(store, profile);
  try {
    return await seed({
      knowledgeSave: (input) => knowledge.save(input, input.kind === 'wiki' ? 'agent' : 'manual'),
      knowledgeFolderSave: (input) => knowledge.saveFolder(input),
    });
  } finally {
    store.close();
  }
}
