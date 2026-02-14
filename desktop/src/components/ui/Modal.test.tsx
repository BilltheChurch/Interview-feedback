import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}}>
        <p>Content</p>
      </Modal>
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders children when open is true', () => {
    render(
      <Modal open={true} onClose={() => {}}>
        <p>Modal content</p>
      </Modal>
    );
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('renders the title when provided', () => {
    render(
      <Modal open={true} onClose={() => {}} title="My Title">
        <p>Body</p>
      </Modal>
    );
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose}>
        <p>Content</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when clicking the backdrop overlay', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose}>
        <p>Content</p>
      </Modal>
    );
    // The backdrop is the outermost fixed div
    const backdrop = screen.getByText('Content').closest('.fixed');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop!);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not call onClose when clicking inside the modal content', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose}>
        <p>Inner content</p>
      </Modal>
    );
    await user.click(screen.getByText('Inner content'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when clicking the close (X) button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} title="Test">
        <p>Content</p>
      </Modal>
    );
    // The X button is a button element inside the modal
    const buttons = screen.getAllByRole('button');
    // The close button is the one within the modal (not the backdrop)
    const closeButton = buttons.find((btn) => btn.querySelector('svg') || btn.closest('.absolute'));
    expect(closeButton).toBeDefined();
    await user.click(closeButton!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('applies sm size class', () => {
    render(
      <Modal open={true} onClose={() => {}} size="sm">
        <p>Small modal</p>
      </Modal>
    );
    const modalPanel = screen.getByText('Small modal').closest('.bg-surface');
    expect(modalPanel?.className).toContain('max-w-[400px]');
  });

  it('applies md size class by default', () => {
    render(
      <Modal open={true} onClose={() => {}}>
        <p>Medium modal</p>
      </Modal>
    );
    const modalPanel = screen.getByText('Medium modal').closest('.bg-surface');
    expect(modalPanel?.className).toContain('max-w-[560px]');
  });

  it('applies lg size class', () => {
    render(
      <Modal open={true} onClose={() => {}} size="lg">
        <p>Large modal</p>
      </Modal>
    );
    const modalPanel = screen.getByText('Large modal').closest('.bg-surface');
    expect(modalPanel?.className).toContain('max-w-[760px]');
  });
});
