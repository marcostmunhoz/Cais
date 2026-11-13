// first: sets the locale before anything renders
import './lib/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const platform = window.cais.platform;
document.documentElement.classList.add(`platform-${platform}`);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App platform={platform} />
  </StrictMode>,
);
