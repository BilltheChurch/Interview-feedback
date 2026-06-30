import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from './ui/Button';
import {
  DIMENSION_PRESETS,
  getPresetByType,
  getInterviewTypeLabelEn,
  generateDimensionKey,
  ensureDimensionKeys,
  type DimensionPresetItem,
} from '../lib/dimensionPresets';

/* ─── Types ─────────────────────────────────── */

export type RubricValue = {
  interviewType: string;
  dimensions: DimensionPresetItem[];
};

type EvaluationRubricEditorProps = {
  value: RubricValue;
  onChange: (value: RubricValue) => void;
};

// Stored template shape (localStorage key `ifb_rubric_templates`).
// Dimensions may be loosely typed for legacy entries (missing `key`/`weight`);
// `ensureDimensionKeys` migrates them lazily on load.
type StoredTemplate = {
  id: string;
  name: string;
  interview_type: string;
  dimensions: DimensionPresetItem[];
};

/* ─── Constants ─────────────────────────────── */

const STORAGE_KEY = 'ifb_rubric_templates';
const MIN_DIMENSIONS = 3;
const MAX_DIMENSIONS = 6;

const WEIGHT_OPTIONS = [1, 2, 3, 4, 5];

const EXPLANATORY_LINE =
  'These dimensions are what the AI uses to score each candidate. Pick a type, then tweak.';

/* ─── localStorage helpers (reused pattern from RubricTemplateModal) ─── */

function readTemplates(): StoredTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate each entry: corrupt/hand-edited templates (e.g. `dimensions: null`
    // or missing) must never reach the dropdown — otherwise selecting one would
    // crash in `ensureDimensionKeys` (dims.map of null). Require at minimum a
    // string `id` and an array `dimensions`.
    return parsed.filter(
      (t): t is StoredTemplate =>
        t != null && typeof t.id === 'string' && Array.isArray(t.dimensions)
    );
  } catch {
    return [];
  }
}

function writeTemplates(templates: StoredTemplate[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch {
    // Best-effort persistence; ignore quota/serialization failures.
  }
}

/* ─── Helpers ───────────────────────────────── */

// Clamp a weight to the supported 1–5 range, defaulting to 1 for bad input.
function clampWeight(w: number): number {
  if (!Number.isFinite(w)) return 1;
  return Math.min(5, Math.max(1, Math.round(w)));
}

/* ─── DimensionRow subcomponent ─────────────── */

type DimensionRowProps = {
  dimension: DimensionPresetItem;
  canDelete: boolean;
  onUpdate: (patch: Partial<DimensionPresetItem>) => void;
  onDelete: () => void;
};

function DimensionRow({ dimension, canDelete, onUpdate, onDelete }: DimensionRowProps) {
  const weightSelectId = `weight-${dimension.key}`;

  return (
    <div
      data-testid="dimension-row"
      className="flex items-start gap-2 p-2.5 rounded-[--radius-button] bg-surface border border-border"
    >
      <div className="flex-1 space-y-2 min-w-0">
        <div className="flex items-center gap-2">
          {/* Name (renders label_en) */}
          <input
            type="text"
            placeholder="Dimension name"
            value={dimension.label_en}
            // Preset dim rename keeps its key — only update label_en here.
            onChange={(e) => onUpdate({ label_en: e.target.value })}
            className="
              flex-1 min-w-0 border border-border rounded-[--radius-button] px-2.5 py-1.5 text-sm
              bg-surface text-ink
              focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent
            "
          />

          {/* Weight */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label htmlFor={weightSelectId} className="text-xs text-ink-tertiary">
              Weight
            </label>
            <select
              id={weightSelectId}
              aria-label="Weight"
              value={dimension.weight}
              onChange={(e) => onUpdate({ weight: clampWeight(Number(e.target.value)) })}
              className="
                border border-border rounded-[--radius-button] px-2 py-1.5 text-xs
                bg-surface text-ink appearance-none pr-5
                focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent
              "
            >
              {WEIGHT_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Description */}
        <input
          type="text"
          placeholder="Description"
          value={dimension.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          className="
            w-full border border-border rounded-[--radius-button] px-2.5 py-1.5 text-xs
            bg-surface text-ink-secondary placeholder:text-ink-tertiary
            focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent
          "
        />
      </div>

      {/* Delete (disabled at MIN_DIMENSIONS) */}
      <button
        type="button"
        onClick={onDelete}
        disabled={!canDelete}
        aria-label={`Remove ${dimension.label_en || 'dimension'}`}
        className="
          flex-shrink-0 mt-1 p-1 rounded-[--radius-chip]
          text-ink-tertiary hover:text-error hover:bg-red-50
          transition-colors cursor-pointer
          disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-ink-tertiary disabled:hover:bg-transparent
        "
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/* ─── EvaluationRubricEditor ─────────────────── */

export function EvaluationRubricEditor({ value, onChange }: EvaluationRubricEditorProps) {
  const { interviewType, dimensions } = value;

  const [templates, setTemplates] = useState<StoredTemplate[]>(() => readTemplates());
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateError, setTemplateError] = useState('');

  /* ── Type pill selection ── */

  const selectType = (type: string) => {
    const preset = getPresetByType(type);
    if (!preset) return;
    // Deep-copy preset dimensions so later edits never mutate the shared preset.
    onChange({
      interviewType: type,
      dimensions: preset.dimensions.map((d) => ({ ...d })),
    });
  };

  /* ── Dimension mutations ── */

  const updateDimension = (index: number, patch: Partial<DimensionPresetItem>) => {
    const next = dimensions.map((d, i) => (i === index ? { ...d, ...patch } : d));
    onChange({ interviewType, dimensions: next });
  };

  const deleteDimension = (index: number) => {
    if (dimensions.length <= MIN_DIMENSIONS) return; // defensive clamp
    const next = dimensions.filter((_, i) => i !== index);
    onChange({ interviewType, dimensions: next });
  };

  const addDimension = () => {
    if (dimensions.length >= MAX_DIMENSIONS) return; // defensive clamp
    // New custom dim: generate a fresh key (preset dims never regenerate).
    const newDim: DimensionPresetItem = {
      key: generateDimensionKey(''),
      label_en: '',
      label_zh: '',
      description: '',
      weight: 1,
    };
    onChange({ interviewType, dimensions: [...dimensions, newDim] });
  };

  /* ── Templates ── */

  const applyTemplate = (id: string) => {
    if (!id) return;
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    // Lazy migration: backfill keys/weights for legacy entries on load.
    onChange({
      interviewType: tpl.interview_type,
      dimensions: ensureDimensionKeys(tpl.dimensions),
    });
  };

  const beginSaveTemplate = () => {
    setTemplateName('');
    setTemplateError('');
    setSavingTemplate(true);
  };

  const confirmSaveTemplate = () => {
    const name = templateName.trim();
    if (!name) {
      setTemplateError('Template name is required');
      return;
    }
    const tpl: StoredTemplate = {
      id: `custom_${Date.now()}`,
      name,
      interview_type: interviewType,
      dimensions: dimensions.map((d) => ({ ...d })),
    };
    const next = [...templates, tpl];
    writeTemplates(next);
    setTemplates(next);
    setSavingTemplate(false);
  };

  const cancelSaveTemplate = () => {
    setSavingTemplate(false);
    setTemplateError('');
  };

  /* ── Render ── */

  const canDelete = dimensions.length > MIN_DIMENSIONS;
  const canAdd = dimensions.length < MAX_DIMENSIONS;

  return (
    <div className="space-y-4">
      {/* Explanatory line */}
      <p className="text-sm text-ink-secondary">{EXPLANATORY_LINE}</p>

      {/* Interview Type pills */}
      <div className="space-y-2">
        <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider">
          Interview Type
        </h3>
        <div className="flex gap-2 flex-wrap">
          {DIMENSION_PRESETS.map((preset) => {
            const active = interviewType === preset.interview_type;
            return (
              <button
                key={preset.interview_type}
                type="button"
                aria-pressed={active}
                onClick={() => selectType(preset.interview_type)}
                className={`px-3 py-1.5 rounded-[--radius-button] text-sm border transition-colors cursor-pointer ${
                  active
                    ? 'border-accent bg-accent-soft text-accent-ink'
                    : 'border-border text-ink-secondary hover:border-accent/50'
                }`}
              >
                {getInterviewTypeLabelEn(preset.interview_type)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Dimensions */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider">
            Evaluation Dimensions
          </h3>
          <span className="text-xs text-ink-tertiary">
            {dimensions.length} of {MAX_DIMENSIONS} (min {MIN_DIMENSIONS})
          </span>
        </div>

        <div className="space-y-2">
          {dimensions.map((dim, index) => (
            <DimensionRow
              key={dim.key}
              dimension={dim}
              canDelete={canDelete}
              onUpdate={(patch) => updateDimension(index, patch)}
              onDelete={() => deleteDimension(index)}
            />
          ))}
        </div>

        {/* Add dimension */}
        <button
          type="button"
          onClick={addDimension}
          disabled={!canAdd}
          className="
            w-full flex items-center justify-center gap-2 py-2
            border-2 border-dashed border-border rounded-[--radius-button]
            text-sm text-ink-secondary font-medium
            hover:border-accent hover:text-accent-ink
            transition-colors cursor-pointer
            disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:text-ink-secondary
          "
        >
          <Plus className="w-4 h-4" />
          Add dimension
        </button>
      </div>

      {/* Templates */}
      <div className="space-y-2 pt-2 border-t border-border">
        <div className="flex items-center justify-between gap-3">
          {/* Saved template selector */}
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <label
              htmlFor="saved-template-select"
              className="text-xs text-ink-tertiary whitespace-nowrap"
            >
              Saved template
            </label>
            <select
              id="saved-template-select"
              aria-label="Saved template"
              value=""
              onChange={(e) => applyTemplate(e.target.value)}
              disabled={templates.length === 0}
              className="
                flex-1 min-w-0 border border-border rounded-[--radius-button] px-2 py-1.5 text-xs
                bg-surface text-ink appearance-none
                focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent
                disabled:opacity-50 disabled:cursor-not-allowed
              "
            >
              <option value="" disabled>
                {templates.length === 0 ? 'No saved templates' : 'Select a template…'}
              </option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {!savingTemplate && (
            <Button variant="secondary" size="sm" onClick={beginSaveTemplate}>
              Save as template
            </Button>
          )}
        </div>

        {/* Inline save form */}
        {savingTemplate && (
          <div className="space-y-2 p-3 rounded-[--radius-button] bg-surface border border-border">
            <input
              type="text"
              placeholder="Template name"
              value={templateName}
              autoFocus
              onChange={(e) => {
                setTemplateName(e.target.value);
                if (templateError) setTemplateError('');
              }}
              className={`
                w-full border rounded-[--radius-button] px-2.5 py-1.5 text-sm bg-surface text-ink
                focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent
                ${templateError ? 'border-error' : 'border-border'}
              `}
            />
            {templateError && <p className="text-xs text-error">{templateError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={cancelSaveTemplate}>
                Cancel
              </Button>
              <Button size="sm" onClick={confirmSaveTemplate}>
                Save
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
