import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EvidenceChip } from './EvidenceChip';

describe('EvidenceChip', () => {
  const defaultProps = {
    timestamp: '02:30',
    speaker: 'Alice',
    quote: 'This is a short quote',
  };

  it('renders the timestamp in brackets', () => {
    render(<EvidenceChip {...defaultProps} />);
    expect(screen.getByText('[02:30]')).toBeInTheDocument();
  });

  it('renders the speaker name with colon', () => {
    render(<EvidenceChip {...defaultProps} />);
    expect(screen.getByText('Alice:')).toBeInTheDocument();
  });

  it('renders the full quote when under 40 characters', () => {
    render(<EvidenceChip {...defaultProps} />);
    expect(screen.getByText(`"${defaultProps.quote}"`)).toBeInTheDocument();
  });

  it('truncates the quote to 40 characters with ellipsis when longer', () => {
    const longQuote =
      'This is a very long quote that definitely exceeds the forty character limit imposed by the component';
    render(<EvidenceChip {...defaultProps} quote={longQuote} />);
    const truncated = longQuote.slice(0, 40) + '...';
    expect(screen.getByText(`"${truncated}"`)).toBeInTheDocument();
  });

  it('does not truncate a quote that is exactly 40 characters', () => {
    const exact40 = 'A'.repeat(40);
    render(<EvidenceChip {...defaultProps} quote={exact40} />);
    expect(screen.getByText(`"${exact40}"`)).toBeInTheDocument();
  });

  it('calls onClick handler when clicked', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<EvidenceChip {...defaultProps} onClick={handleClick} />);
    await user.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('renders as a button element', () => {
    render(<EvidenceChip {...defaultProps} />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('merges additional className', () => {
    render(<EvidenceChip {...defaultProps} className="extra-class" />);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('extra-class');
  });
});
