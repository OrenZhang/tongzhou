import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cp } from 'node:fs/promises';
export default defineConfig(({ mode }) => ({
  base: './',
  build: { license: { fileName: 'THIRD_PARTY_LICENSES.md' } },
  optimizeDeps: { exclude: ['@excalidraw/excalidraw'] },
  plugins: [
    {
      name: 'tauri-ipc-csp',
      transformIndexHtml(html) {
        if (mode !== 'tauri') return html;
        return html.replace("connect-src 'self'", "connect-src 'self' ipc: http://ipc.localhost");
      },
    },
    react(),
    {
      name: 'local-excalidraw-fonts',
      enforce: 'pre',
      resolveId(source, importer) {
        if (
          source.endsWith('/subset-shared.chunk.js') &&
          importer?.replaceAll('\\', '/').includes('/@excalidraw/excalidraw/dist/')
        )
          return '\0cosail-whiteboard-font-export';
      },
      load(id) {
        if (
          id !== '\0cosail-whiteboard-font-export' &&
          !(
            id.replaceAll('\\', '/').includes('/@excalidraw/excalidraw/dist/') &&
            id.endsWith('/subset-shared.chunk.js')
          )
        )
          return;
        // Embed the original WOFF2 bytes. Upstream's optional glyph optimizer
        // uses dynamic code generation, which the desktop CSP intentionally blocks.
        return `export const Commands={Subset:'SUBSET'};
          export const toBase64=buffer=>new Promise((resolve,reject)=>{
            const reader=new FileReader();reader.onload=()=>resolve(reader.result);
            reader.onerror=()=>reject(reader.error);
            reader.readAsDataURL(new Blob([buffer],{type:'font/woff2'}));
          });export const subsetToBase64=toBase64;export const subsetToBinary=async buffer=>buffer;`;
      },
      // The upstream editor always appends a CDN font fallback, even with a local
      // asset path. Keep both sources local in the desktop bundle (including dev).
      transform(code, id) {
        if (!id.replaceAll('\\', '/').includes('/@excalidraw/excalidraw/dist/')) return;
        let result = code;
        if (code.includes('ASSETS_FALLBACK_URL') && code.includes('https://esm.sh/')) {
          result = code.replace(
            /`https:\/\/esm\.sh\/[\s\S]*?\/dist\/prod\/`/g,
            'new URL("./excalidraw-assets/", document.baseURI).href',
          );
          if (result === code)
            throw new Error('Excalidraw font fallback changed; review the local asset adapter');
        }
        if (code.includes('Failed to use workers for subsetting')) {
          const next = result.replace(/typeof Worker(?:\s*!==\s*"undefined"|<"u")/g, 'false');
          if (next === result)
            throw new Error(
              'Excalidraw font worker detection changed; review the local asset adapter',
            );
          result = next;
        }
        if (result !== code) return { code: result, map: null };
      },
      async buildStart() {
        await cp(
          'node_modules/@excalidraw/excalidraw/dist/prod/fonts',
          'public/excalidraw-assets/fonts',
          { recursive: true },
        );
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
}));
