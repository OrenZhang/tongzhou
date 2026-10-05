import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './appearance.css';
import './controls.css';
import './markdown.css';
import { applyAppearance, savedAppearance } from './Appearance';
applyAppearance(savedAppearance());
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
