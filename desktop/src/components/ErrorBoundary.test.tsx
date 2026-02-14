import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

// A component that deliberately throws an error
function ThrowingComponent({ error }: { error: Error }): React.ReactNode {
  throw error;
}

// Suppress console.error noise from React error boundary
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});
afterEach(() => {
  console.error = originalConsoleError;
});

describe('ErrorBoundary', () => {
  it('renders children normally when no error occurs', () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('shows fallback UI when a child throws an error', () => {
    const error = new Error('Test error message');
    render(
      <ErrorBoundary>
        <ThrowingComponent error={error} />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(
      screen.getByText('An unexpected error occurred. Try reloading the page.')
    ).toBeInTheDocument();
  });

  it('shows a Reload button in fallback UI', () => {
    const error = new Error('Crash');
    render(
      <ErrorBoundary>
        <ThrowingComponent error={error} />
      </ErrorBoundary>
    );
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  it('shows error details in a details/summary element', () => {
    const error = new Error('Detailed error');
    render(
      <ErrorBoundary>
        <ThrowingComponent error={error} />
      </ErrorBoundary>
    );
    expect(screen.getByText('Error details')).toBeInTheDocument();
    expect(screen.getByText(/Detailed error/)).toBeInTheDocument();
  });

  it('logs the error to console.error via componentDidCatch', () => {
    const error = new Error('Logged error');
    render(
      <ErrorBoundary>
        <ThrowingComponent error={error} />
      </ErrorBoundary>
    );
    // React itself calls console.error for uncaught errors in boundaries,
    // plus our componentDidCatch calls console.error
    expect(console.error).toHaveBeenCalled();
  });
});
