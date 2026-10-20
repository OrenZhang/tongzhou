import React from 'react';
import ReactDOM from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import './app/styles.css';
import './features/settings/appearance.css';
import './components/controls/controls.css';
import './components/markdown/markdown.css';
import './features/workspace/workspace.css';
import './app/ui-system.css';
import './app/icons.css';
import { applyAppearance, savedAppearance } from './features/settings/Appearance';
async function start() {
  if (isTauri()) {
    const { connectTauri } = await import('./platform/tauri');
    window.tongzhou = await connectTauri();
  }
  const { default: App } = await import('./app/App');
  applyAppearance(savedAppearance());
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
void start().catch((error) => {
  document.getElementById('root')!.textContent = String(error);
});
