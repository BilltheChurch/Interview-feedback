import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EvaluationRubricEditor } from './EvaluationRubricEditor';
import {
  getPresetByType,
  type DimensionPresetItem,
} from '../lib/dimensionPresets';

/* ─── Helpers ───────────────────────────────── */

const STORAGE_KEY = 'ifb_rubric_templates';

// Build a deep-copied academic rubric value (the default the component is given).
function academicValue(): { interviewType: string; dimensions: DimensionPresetItem[] } {
  const preset = getPresetByType('academic')!;
  return {
    interviewType: 'academic',
    dimensions: preset.dimensions.map((d) => ({ ...d })),
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('EvaluationRubricEditor', () => {
  /* ── Type pills ── */

  it('renders the explanatory line and 4 English type pills', () => {
    render(<EvaluationRubricEditor value={academicValue()} onChange={() => {}} />);
    expect(
      screen.getByText(
        'These dimensions are what the AI uses to score each candidate. Pick a type, then tweak.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Academic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Technical' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Behavioral' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group' })).toBeInTheDocument();
  });

  it('clicking "Technical" loads that preset and calls onChange with technical dimensions', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluationRubricEditor value={academicValue()} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Technical' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg.interviewType).toBe('technical');
    const keys = arg.dimensions.map((d: DimensionPresetItem) => d.key);
    expect(keys).toContain('problem_analysis');
    expect(keys).toContain('coding_ability');
    // Should be a full deep copy of the technical preset (5 dims)
    expect(arg.dimensions).toHaveLength(5);
  });

  /* ── Dimension editing ── */

  it('editing a dimension name calls onChange but keeps a PRESET dim key unchanged', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = academicValue();
    const originalKey = value.dimensions[0].key; // "academic_motivation"
    render(<EvaluationRubricEditor value={value} onChange={onChange} />);

    const nameInputs = screen.getAllByPlaceholderText('Dimension name');
    await user.type(nameInputs[0], 'X');

    expect(onChange).toHaveBeenCalled();
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    // Preset dim must keep its original key after a rename
    expect(lastArg.dimensions[0].key).toBe(originalKey);
  });

  it('editing a dimension weight calls onChange with the new clamped weight', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluationRubricEditor value={academicValue()} onChange={onChange} />);

    const weightSelects = screen.getAllByLabelText('Weight');
    await user.selectOptions(weightSelects[0], '5');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg.dimensions[0].weight).toBe(5);
  });

  it('editing a dimension description calls onChange with the new description', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluationRubricEditor value={academicValue()} onChange={onChange} />);

    const descInputs = screen.getAllByPlaceholderText('Description');
    await user.type(descInputs[0], 'Z');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg.dimensions[0].description).toMatch(/Z$/);
  });

  /* ── Add / delete with bounds ── */

  it('"Add dimension" appends a custom dim with a generated custom_ key', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluationRubricEditor value={academicValue()} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /add dimension/i }));

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg.dimensions).toHaveLength(6);
    expect(lastArg.dimensions[5].key).toMatch(/^custom_/);
  });

  it('disables "Add dimension" at 6 dimensions', () => {
    const value = academicValue();
    // academic has 5; push a 6th to hit the cap
    value.dimensions.push({
      key: 'custom_extra_aaaaaa',
      label_en: 'Extra',
      label_zh: '',
      description: '',
      weight: 1,
    });
    render(<EvaluationRubricEditor value={value} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /add dimension/i })).toBeDisabled();
  });

  it('disables delete buttons at exactly 3 dimensions', () => {
    const value = academicValue();
    value.dimensions = value.dimensions.slice(0, 3); // exactly 3
    render(<EvaluationRubricEditor value={value} onChange={() => {}} />);
    const deleteButtons = screen.getAllByRole('button', { name: /remove/i });
    deleteButtons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it('delete removes a dimension and calls onChange when above 3', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluationRubricEditor value={academicValue()} onChange={onChange} />);

    const deleteButtons = screen.getAllByRole('button', { name: /remove/i });
    expect(deleteButtons[0]).not.toBeDisabled();
    await user.click(deleteButtons[0]);

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg.dimensions).toHaveLength(4);
  });

  /* ── Templates (localStorage) ── */

  it('"Save as template" persists the current rubric to localStorage', async () => {
    const user = userEvent.setup();
    render(<EvaluationRubricEditor value={academicValue()} onChange={() => {}} />);

    await user.click(screen.getByRole('button', { name: /save as template/i }));

    // A name prompt appears; type a name and confirm.
    const nameInput = await screen.findByPlaceholderText(/template name/i);
    await user.type(nameInput, 'My Rubric');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('My Rubric');
    expect(stored[0].interview_type).toBe('academic');
    expect(stored[0].dimensions.length).toBeGreaterThanOrEqual(3);
  });

  it('a saved template can be re-selected, applying its dimensions via onChange', async () => {
    // Pre-seed a stored template whose dims include a legacy item missing `key`.
    const stored = [
      {
        id: 'tpl_1',
        name: 'Saved Tech',
        interview_type: 'technical',
        dimensions: [
          { label_en: 'Legacy Dim', label_zh: '', description: 'd', weight: 4 }, // no key
          { key: 'coding_ability', label_en: 'Coding Ability', label_zh: '', description: 'd', weight: 2 },
          { key: 'system_design', label_en: 'System Design', label_zh: '', description: 'd', weight: 1 },
        ],
      },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluationRubricEditor value={academicValue()} onChange={onChange} />);

    // The saved template is offered for selection (dropdown / pill).
    const templateSelect = screen.getByLabelText(/saved template/i);
    await user.selectOptions(templateSelect, 'tpl_1');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg.interviewType).toBe('technical');
    expect(lastArg.dimensions).toHaveLength(3);
    // Lazy migration: legacy dim missing a key gets a generated custom_ key.
    expect(lastArg.dimensions[0].key).toMatch(/^custom_/);
    expect(lastArg.dimensions[1].key).toBe('coding_ability');
  });

  it('ignores corrupt stored templates (dimensions null/missing) without crashing', async () => {
    // Pre-seed storage with two broken entries plus one valid entry.
    const stored = [
      { id: 'broken_null', name: 'Broken Null', interview_type: 'technical', dimensions: null },
      { id: 'broken_missing', name: 'Broken Missing', interview_type: 'group' }, // no dimensions
      {
        id: 'valid_1',
        name: 'Valid Tpl',
        interview_type: 'behavioral',
        dimensions: [
          { key: 'leadership', label_en: 'Leadership', label_zh: '', description: 'd', weight: 3 },
          { key: 'collaboration', label_en: 'Collaboration', label_zh: '', description: 'd', weight: 2 },
          { key: 'resilience', label_en: 'Resilience', label_zh: '', description: 'd', weight: 1 },
        ],
      },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const user = userEvent.setup();
    const onChange = vi.fn();

    // (a) renders without throwing
    render(<EvaluationRubricEditor value={academicValue()} onChange={onChange} />);

    const templateSelect = screen.getByLabelText(/saved template/i) as HTMLSelectElement;
    // (b) corrupt entries are NOT offered as selectable options
    const optionValues = Array.from(templateSelect.options).map((o) => o.value);
    expect(optionValues).not.toContain('broken_null');
    expect(optionValues).not.toContain('broken_missing');
    expect(optionValues).toContain('valid_1');

    // (c) the valid template still loads correctly
    await user.selectOptions(templateSelect, 'valid_1');
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg.interviewType).toBe('behavioral');
    expect(lastArg.dimensions).toHaveLength(3);
    expect(lastArg.dimensions[0].key).toBe('leadership');
  });

  /* ── Rendering the English labels ── */

  it('renders dimension label_en values in the name inputs', () => {
    render(<EvaluationRubricEditor value={academicValue()} onChange={() => {}} />);
    const nameInputs = screen.getAllByPlaceholderText('Dimension name') as HTMLInputElement[];
    const values = nameInputs.map((i) => i.value);
    expect(values).toContain('Academic Motivation');
    expect(values).toContain('Domain Knowledge');
  });

  it('marks the active type pill as pressed', () => {
    render(<EvaluationRubricEditor value={academicValue()} onChange={() => {}} />);
    const academicPill = screen.getByRole('button', { name: 'Academic' });
    const technicalPill = screen.getByRole('button', { name: 'Technical' });
    expect(academicPill).toHaveAttribute('aria-pressed', 'true');
    expect(technicalPill).toHaveAttribute('aria-pressed', 'false');
  });

  it('uses within() to confirm each dimension row has name, description and weight controls', () => {
    render(<EvaluationRubricEditor value={academicValue()} onChange={() => {}} />);
    const rows = screen.getAllByTestId('dimension-row');
    expect(rows).toHaveLength(5);
    const firstRow = within(rows[0]);
    expect(firstRow.getByPlaceholderText('Dimension name')).toBeInTheDocument();
    expect(firstRow.getByPlaceholderText('Description')).toBeInTheDocument();
    expect(firstRow.getByLabelText('Weight')).toBeInTheDocument();
  });
});
