import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RadarChart } from './RadarChart';
import type { DimensionFeedback } from './types';

function makeDim(
  dimension: string,
  score: number,
  label_zh?: string,
): DimensionFeedback {
  return {
    dimension,
    label_zh,
    score,
    claims: [],
  };
}

describe('RadarChart', () => {
  it('renders nothing when fewer than 3 active dimensions', () => {
    const { container } = render(
      <RadarChart
        dimensions={[
          makeDim('leadership', 7),
          makeDim('collaboration', 5),
        ]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders SVG when 3 or more active dimensions are provided', () => {
    const { container } = render(
      <RadarChart
        dimensions={[
          makeDim('leadership', 7),
          makeDim('collaboration', 5),
          makeDim('logic', 8),
        ]}
      />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders SVG with 5 dimensions', () => {
    const { container } = render(
      <RadarChart
        dimensions={[
          makeDim('leadership', 7),
          makeDim('collaboration', 5),
          makeDim('logic', 8),
          makeDim('structure', 6),
          makeDim('initiative', 9),
        ]}
      />,
    );
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg?.getAttribute('width')).toBe('180');
    expect(svg?.getAttribute('height')).toBe('180');
  });

  it('renders label_zh text for dimensions when provided', () => {
    render(
      <RadarChart
        dimensions={[
          makeDim('leadership', 7, '领导力'),
          makeDim('collaboration', 5, '协作能力'),
          makeDim('logic', 8, '逻辑'),
        ]}
      />,
    );
    // SVG text elements contain the labels
    expect(screen.getByText(/领导力/)).toBeInTheDocument();
    expect(screen.getByText(/协作能力/)).toBeInTheDocument();
    expect(screen.getByText(/逻辑/)).toBeInTheDocument();
  });

  it('filters out not_applicable dimensions', () => {
    // Only 2 active dimensions → should render nothing
    const { container } = render(
      <RadarChart
        dimensions={[
          makeDim('leadership', 7),
          makeDim('collaboration', 5),
          { dimension: 'logic', score: 8, claims: [], not_applicable: true },
          { dimension: 'structure', score: 6, claims: [], not_applicable: true },
        ]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders ring labels (2.5, 5.0, 7.5, 10)', () => {
    render(
      <RadarChart
        dimensions={[
          makeDim('leadership', 7),
          makeDim('collaboration', 5),
          makeDim('logic', 8),
        ]}
      />,
    );
    expect(screen.getByText('2.5')).toBeInTheDocument();
    expect(screen.getByText('5.0')).toBeInTheDocument();
    expect(screen.getByText('7.5')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('renders score value in axis label when dimension has a numeric score', () => {
    render(
      <RadarChart
        dimensions={[
          makeDim('leadership', 7, '领导力'),
          makeDim('collaboration', 5, '协作'),
          makeDim('logic', 8, '逻辑'),
        ]}
      />,
    );
    // Each axis label shows e.g. "领导力 7" or "领导力 7.0"
    expect(screen.getByText(/领导力.*7/)).toBeInTheDocument();
  });

  it('renders scores based on claim ratios when score is missing', () => {
    const dimNoScore: DimensionFeedback = {
      dimension: 'collaboration',
      claims: [
        { id: 'c1', text: 'Good', category: 'strength', confidence: 0.8, evidence_refs: [] },
        { id: 'c2', text: 'Bad', category: 'risk', confidence: 0.5, evidence_refs: [] },
      ],
    };
    const { container } = render(
      <RadarChart
        dimensions={[
          dimNoScore,
          makeDim('leadership', 7),
          makeDim('logic', 8),
        ]}
      />,
    );
    // Should still render SVG with at least 3 active dimensions
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});
