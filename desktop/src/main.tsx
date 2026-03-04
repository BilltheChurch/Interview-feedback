import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './globals.css';

// TODO: Initialize Sentry here for production error tracking.
// import * as Sentry from '@sentry/electron/renderer';
// Sentry.init({ dsn: import.meta.env.VITE_SENTRY_DSN, release: APP_VERSION });
// Wrap the render call with Sentry.wrap() if needed for React error boundaries.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
