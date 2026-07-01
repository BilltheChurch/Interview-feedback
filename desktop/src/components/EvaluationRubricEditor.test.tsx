import { useState } from 'react';
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
    // Pre-seed a stored template whose first dim is a GENUINE legacy entry
    // written by the now-deleted RubricTemplateModal: { name, weight, description }
    // — no key, no label_en/label_zh. Lazy migration must carry `name` into
    // label_en and derive the key from it, NOT leave the name blank.
    const stored = [
      {
        id: 'tpl_1',
        name: 'Saved Tech',
        interview_type: 'technical',
        dimensions: [
          { name: 'Legacy Dim', weight: 4, description: 'd' }, // real legacy shape
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
    // Lazy migration: legacy dim's `name` survives into label_en (NOT blank).
    expect(lastArg.dimensions[0].label_en).toBe('Legacy Dim');
    expect(lastArg.dimensions[0].key).toMatch(/^custom_legacy_dim_[a-z0-9]{6}$/);
    expect(lastArg.dimensions[0].weight).toBe(4);
    expect(lastArg.dimensions[1].key).toBe('coding_ability');
  });

  it('renders the migrated legacy name (not a blank input) after selecting a legacy template', async () => {
    // Drive the migrated rubric back into the editor and assert the name input
    // shows the legacy `name`, proving the migrated label_en reaches the UI.
    const stored = [
      {
        id: 'tpl_legacy',
        name: 'Legacy Tpl',
        interview_type: 'behavioral',
        dimensions: [
          { name: 'Communication', weight: 3, description: 'Clarity' }, // real legacy shape
          { name: 'Teamwork', weight: 2, description: 'Cooperation' },
          { name: 'Drive', weight: 1, description: 'Ambition' },
        ],
      },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const user = userEvent.setup();
    // Controlled wrapper so the editor re-renders with the migrated dimensions.
    function Harness() {
      const [val, setVal] = useState(academicValue());
      return <EvaluationRubricEditor value={val} onChange={setVal} />;
    }
    render(<Harness />);

    await user.selectOptions(screen.getByLabelText(/saved template/i), 'tpl_legacy');

    const nameInputs = screen.getAllByPlaceholderText('Dimension name') as HTMLInputElement[];
    const values = nameInputs.map((i) => i.value);
    expect(values).toContain('Communication');
    expect(values).toContain('Teamwork');
    // No migrated dimension renders with a blank name.
    expect(values.every((v) => v.trim().length > 0)).toBe(true);
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

  /* ── 选中项显示（selectedTemplateId state 修复）── */

  it('选择 template 后下拉框显示该 template 名（value 变为其 id，不再是占位符）', async () => {
    const stored = [
      {
        id: 'tpl_show',
        name: 'My Show Template',
        interview_type: 'technical',
        dimensions: [
          { key: 'k1', label_en: 'D1', label_zh: '', description: 'd', weight: 1 },
          { key: 'k2', label_en: 'D2', label_zh: '', description: 'd', weight: 2 },
          { key: 'k3', label_en: 'D3', label_zh: '', description: 'd', weight: 3 },
        ],
      },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const user = userEvent.setup();
    function Harness() {
      const [val, setVal] = useState(academicValue());
      return <EvaluationRubricEditor value={val} onChange={setVal} />;
    }
    render(<Harness />);

    const templateSelect = screen.getByLabelText(/saved template/i) as HTMLSelectElement;
    // 选择前：下拉 value 为空（占位符）
    expect(templateSelect.value).toBe('');

    await user.selectOptions(templateSelect, 'tpl_show');

    // 选择后：下拉 value 应为 template id，select 显示模板名而非占位符
    expect(templateSelect.value).toBe('tpl_show');
    // 当前选中 option 的文本应为模板名
    const selectedOption = templateSelect.options[templateSelect.selectedIndex];
    expect(selectedOption.text).toBe('My Show Template');
  });

  it('另存新 template 后下拉框自动选中新模板', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [val, setVal] = useState(academicValue());
      return <EvaluationRubricEditor value={val} onChange={setVal} />;
    }
    render(<Harness />);

    // 另存为
    await user.click(screen.getByRole('button', { name: /save as template/i }));
    const nameInput = await screen.findByPlaceholderText(/template name/i);
    await user.type(nameInput, 'Auto Select Tpl');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // 保存后下拉应自动选中新模板
    const templateSelect = screen.getByLabelText(/saved template/i) as HTMLSelectElement;
    expect(templateSelect.value).not.toBe('');
    const selectedOption = templateSelect.options[templateSelect.selectedIndex];
    expect(selectedOption.text).toBe('Auto Select Tpl');
  });

  /* ── Rendering the English labels ── */

  it('renders only English (no CJK) in the description inputs for the default academic preset (D6)', () => {
    // The description fields are rendered UI copy bound into visible inputs, so
    // they must be English-only — not just the type label on the Review step.
    render(<EvaluationRubricEditor value={academicValue()} onChange={() => {}} />);
    const descInputs = screen.getAllByPlaceholderText('Description') as HTMLInputElement[];
    expect(descInputs.length).toBeGreaterThan(0);
    for (const input of descInputs) {
      expect(input.value).not.toMatch(/[一-鿿]/);
    }
  });

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
