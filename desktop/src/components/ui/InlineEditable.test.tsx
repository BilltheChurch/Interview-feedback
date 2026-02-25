import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InlineEditable } from './InlineEditable';

describe('InlineEditable', () => {
  it('renders text in display mode', () => {
    render(<InlineEditable value="hello" onSave={vi.fn()} />);
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('switches to textarea on double-click', () => {
    render(<InlineEditable value="hello" onSave={vi.fn()} />);
    fireEvent.doubleClick(screen.getByText('hello'));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('calls onSave on blur', () => {
    const onSave = vi.fn();
    render(<InlineEditable value="hello" onSave={onSave} />);
    fireEvent.doubleClick(screen.getByText('hello'));
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'updated' } });
    fireEvent.blur(textarea);
    expect(onSave).toHaveBeenCalledWith('updated');
  });

  it('cancels on Escape', () => {
    const onSave = vi.fn();
    render(<InlineEditable value="hello" onSave={onSave} />);
    fireEvent.doubleClick(screen.getByText('hello'));
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'changed' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('hello')).toBeTruthy();
  });
});
