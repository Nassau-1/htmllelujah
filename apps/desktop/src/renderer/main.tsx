import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RENDERER_CSS } from '@htmllelujah/renderer';

import { App } from './App';
import '../styles/tokens.css';
import '../styles/global.css';
import '../styles/editor.css';

const root = document.querySelector<HTMLDivElement>('#root');

if (!root) throw new Error('Renderer root was not found');

createRoot(root).render(
  <StrictMode>
    <style>{RENDERER_CSS}</style>
    <App />
  </StrictMode>,
);
