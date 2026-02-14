import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Chip } from './Chip';

describe('Chip', () => {
  it('renders children text', () => {
    render(<Chip>Label</Chip>);
    expect(screen.getByText('Label')).toBeInTheDocument();
  });

  it('applies default variant styles when no variant specified', () => {
    render(<Chip>Default</Chip>);
    const chip = screen.getByText('Default');
    expect(chip.className).toContain('bg-surface-hover');
    expect(chip.className).toContain('text-ink-secondary');
  });

  it('applies accent variant styles', () => {
    render(<Chip variant="accent">Accent</Chip>);
    const chip = screen.getByText('Accent');
    expect(chip.className).toContain('bg-accent-soft');
    expect(chip.className).toContain('text-accent');
  });

  it('applies info variant styles', () => {
    render(<Chip variant="info">Info</Chip>);
    const chip = screen.getByText('Info');
    expect(chip.className).toContain('bg-blue-50');
    expect(chip.className).toContain('text-blue-700');
  });

  it('applies warning variant styles', () => {
    render(<Chip variant="warning">Warning</Chip>);
    const chip = screen.getByText('Warning');
    expect(chip.className).toContain('bg-amber-50');
    expect(chip.className).toContain('text-amber-700');
  });

  it('applies error variant styles', () => {
    render(<Chip variant="error">Error</Chip>);
    const chip = screen.getByText('Error');
    expect(chip.className).toContain('bg-red-50');
    expect(chip.className).toContain('text-error');
  });

  it('applies success variant styles', () => {
    render(<Chip variant="success">Success</Chip>);
    const chip = screen.getByText('Success');
    expect(chip.className).toContain('bg-emerald-50');
    expect(chip.className).toContain('text-success');
  });

  it('merges additional className', () => {
    render(<Chip className="my-custom-class">Custom</Chip>);
    const chip = screen.getByText('Custom');
    expect(chip.className).toContain('my-custom-class');
  });

  it('renders as an inline-flex span element', () => {
    render(<Chip>Inline</Chip>);
    const chip = screen.getByText('Inline');
    expect(chip.tagName).toBe('SPAN');
    expect(chip.className).toContain('inline-flex');
  });
});
