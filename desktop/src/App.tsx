import { useState, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PipOverlay } from './components/PipOverlay';
import { HomeView } from './views/HomeView';
import { SetupView } from './views/SetupView';
import { SidecarView } from './views/SidecarView';
import { FeedbackView } from './views/FeedbackView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';
import { LoginView } from './views/LoginView';
import { useDeepLink } from './hooks/useDeepLink';

function AppRoutes() {
  useDeepLink();
  const location = useLocation();

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="h-full"
      >
        <Routes location={location}>
          <Route path="/" element={<ErrorBoundary><HomeView /></ErrorBoundary>} />
          <Route path="/setup" element={<ErrorBoundary><SetupView /></ErrorBoundary>} />
          <Route path="/session" element={<ErrorBoundary><SidecarView /></ErrorBoundary>} />
          <Route path="/feedback/:sessionId" element={<ErrorBoundary><FeedbackView /></ErrorBoundary>} />
          <Route path="/history" element={<ErrorBoundary><HistoryView /></ErrorBoundary>} />
          <Route path="/settings" element={<ErrorBoundary><SettingsView /></ErrorBoundary>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}

export function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const state = await window.desktopAPI.authGetState();
        setIsAuthenticated(state.microsoft.connected || state.google.connected);
      } catch {
        // If auth check fails (e.g. not in Electron), allow through
        setIsAuthenticated(false);
      }
      setAuthChecked(true);
    })();
  }, []);

  if (!authChecked) {
    return null;
  }

  if (!isAuthenticated) {
    return <LoginView onAuthenticated={() => setIsAuthenticated(true)} />;
  }

  return (
    <HashRouter>
      <AppShell>
        <AppRoutes />
      </AppShell>
      <PipOverlay />
    </HashRouter>
  );
}
