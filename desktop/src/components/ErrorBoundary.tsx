import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Card } from './ui/Card';

type Props = { children: ReactNode };
type State = { hasError: boolean; error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex items-center justify-center min-h-[320px] p-8">
        <Card className="max-w-md w-full p-6 text-center space-y-4">
          <div className="text-4xl text-error" aria-hidden>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="mx-auto h-12 w-12"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>

          <h2 className="text-lg font-semibold text-ink">Something went wrong</h2>
          <p className="text-sm text-ink-secondary">
            An unexpected error occurred. Try reloading the page.
          </p>

          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center px-4 py-2 rounded-[--radius-button] bg-accent text-white font-medium text-sm hover:bg-accent-hover transition-colors"
          >
            Reload
          </button>

          {this.state.error && (
            <details className="text-left mt-4">
              <summary className="text-xs text-ink-tertiary cursor-pointer hover:text-ink-secondary">
                Error details
              </summary>
              <pre className="mt-2 p-3 bg-bg rounded-[--radius-chip] text-xs text-ink-secondary font-mono overflow-auto max-h-40">
                {this.state.error.message}
                {'\n'}
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </Card>
      </div>
    );
  }
}
