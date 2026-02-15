import { useState } from 'react';
import { motion } from 'motion/react';
import { AudioLines, AlertCircle, Loader2 } from 'lucide-react';

type LoginViewProps = {
  onAuthenticated: () => void;
};

export function LoginView({ onAuthenticated }: LoginViewProps) {
  const [loading, setLoading] = useState<'microsoft' | 'google' | null>(null);
  const [error, setError] = useState('');

  const handleMicrosoft = async () => {
    setLoading('microsoft');
    setError('');
    try {
      await window.desktopAPI.calendarConnectMicrosoft();
      onAuthenticated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Microsoft sign-in failed');
      setLoading(null);
    }
  };

  const handleGoogle = async () => {
    setLoading('google');
    setError('');
    try {
      await window.desktopAPI.googleConnect();
      onAuthenticated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Google sign-in failed');
      setLoading(null);
    }
  };

  const handleSkip = () => {
    onAuthenticated();
  };

  return (
    <div className="h-screen w-screen bg-bg flex items-center justify-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col items-center gap-8 max-w-sm w-full px-6"
      >
        {/* Branding */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-2xl bg-accent flex items-center justify-center shadow-card">
            <AudioLines className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-semibold text-ink tracking-tight">Chorus</h1>
          <p className="text-sm text-ink-secondary">Every voice counts</p>
        </div>

        {/* Sign-in buttons */}
        <div className="w-full space-y-3">
          {/* Microsoft button */}
          <button
            onClick={handleMicrosoft}
            disabled={loading !== null}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-[--radius-button] font-medium text-sm transition-colors duration-150 bg-[#2F2F2F] text-white hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {loading === 'microsoft' ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 21 21" fill="none">
                <rect x="1" y="1" width="9" height="9" fill="#F25022" />
                <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
              </svg>
            )}
            Sign in with Microsoft
          </button>

          {/* Google button */}
          <button
            onClick={handleGoogle}
            disabled={loading !== null}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-[--radius-button] font-medium text-sm transition-colors duration-150 bg-white border border-border text-ink hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {loading === 'google' ? (
              <Loader2 className="w-5 h-5 animate-spin text-ink-tertiary" />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
            )}
            Sign in with Google
          </button>
        </div>

        {/* Error message */}
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 text-error text-xs w-full"
          >
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </motion.div>
        )}

        {/* Skip link */}
        <button
          onClick={handleSkip}
          disabled={loading !== null}
          className="text-xs text-ink-tertiary hover:text-ink-secondary transition-colors cursor-pointer disabled:opacity-50"
        >
          Continue without sign-in
        </button>
      </motion.div>
    </div>
  );
}
