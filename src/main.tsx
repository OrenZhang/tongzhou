import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';
import './app/styles.css';
import './features/settings/appearance.css';
import './components/controls/controls.css';
import './components/markdown/markdown.css';
import './features/workspace/workspace.css';
import './app/ui-system.css';
import './app/icons.css';
import { applyAppearance, savedAppearance } from './features/settings/Appearance';
applyAppearance(savedAppearance());
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
