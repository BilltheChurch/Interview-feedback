import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastContainer, type ToastItem } from './Toast';

describe('ToastContainer', () => {
  const sampleToasts: ToastItem[] = [
    { id: '1', message: 'Success message', type: 'success' },
    { id: '2', message: 'Error occurred', type: 'error' },
    { id: '3', message: 'A warning', type: 'warning' },
    { id: '4', message: 'Info notice', type: 'info' },
  ];

  it('renders all toast messages', () => {
    render(<ToastContainer toasts={sampleToasts} onDismiss={() => {}} />);
    expect(screen.getByText('Success message')).toBeInTheDocument();
    expect(screen.getByText('Error occurred')).toBeInTheDocument();
    expect(screen.getByText('A warning')).toBeInTheDocument();
    expect(screen.getByText('Info notice')).toBeInTheDocument();
  });

  it('renders toast items with role="alert"', () => {
    render(
      <ToastContainer
        toasts={[{ id: '1', message: 'Alert toast', type: 'info' }]}
        onDismiss={() => {}}
      />
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('calls onDismiss with the correct id when dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <ToastContainer
        toasts={[{ id: 'toast-42', message: 'Dismissible', type: 'success' }]}
        onDismiss={onDismiss}
      />
    );
    const dismissButton = screen.getByLabelText('Dismiss');
    await user.click(dismissButton);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledWith('toast-42');
  });

  it('renders nothing when toasts array is empty', () => {
    const { container } = render(
      <ToastContainer toasts={[]} onDismiss={() => {}} />
    );
    // The container div is still rendered, but has no toast children
    const alerts = screen.queryAllByRole('alert');
    expect(alerts).toHaveLength(0);
  });

  it('applies success type styles', () => {
    render(
      <ToastContainer
        toasts={[{ id: '1', message: 'OK', type: 'success' }]}
        onDismiss={() => {}}
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-success');
    expect(alert.className).toContain('text-success');
  });

  it('applies error type styles', () => {
    render(
      <ToastContainer
        toasts={[{ id: '1', message: 'Fail', type: 'error' }]}
        onDismiss={() => {}}
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-error');
    expect(alert.className).toContain('text-error');
  });

  it('applies warning type styles', () => {
    render(
      <ToastContainer
        toasts={[{ id: '1', message: 'Warn', type: 'warning' }]}
        onDismiss={() => {}}
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-warning');
    expect(alert.className).toContain('text-warning');
  });

  it('applies info type styles', () => {
    render(
      <ToastContainer
        toasts={[{ id: '1', message: 'FYI', type: 'info' }]}
        onDismiss={() => {}}
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-accent');
    expect(alert.className).toContain('text-accent');
  });
});
