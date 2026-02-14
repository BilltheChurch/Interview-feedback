import { useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { TextField } from './ui/TextField';
import { TextArea } from './ui/TextArea';

/* ─── Types ─────────────────────────────────── */

export type CustomTemplate = {
  id: string;
  name: string;
  description: string;
  dimensions: { name: string; weight: number; description: string }[];
};

type RubricTemplateModalProps = {
  open: boolean;
  onClose: () => void;
  onSave: (template: CustomTemplate) => void;
  editTemplate?: CustomTemplate | null;
};

/* ─── Default dimensions for new templates ──── */

const DEFAULT_DIMENSIONS: CustomTemplate['dimensions'] = [
  { name: 'Communication', weight: 3, description: '' },
  { name: 'Technical Skills', weight: 3, description: '' },
  { name: 'Problem Solving', weight: 3, description: '' },
];

/* ─── Weight labels ─────────────────────────── */

const WEIGHT_LABELS: Record<number, string> = {
  1: 'Low',
  2: 'Medium-Low',
  3: 'Medium',
  4: 'Medium-High',
  5: 'High',
};

/* ─── RubricTemplateModal ───────────────────── */

export function RubricTemplateModal({
  open,
  onClose,
  onSave,
  editTemplate,
}: RubricTemplateModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dimensions, setDimensions] = useState<CustomTemplate['dimensions']>([]);
  const [nameError, setNameError] = useState('');

  // Reset form when opening
  useEffect(() => {
    if (open) {
      if (editTemplate) {
        setName(editTemplate.name);
        setDescription(editTemplate.description);
        setDimensions(editTemplate.dimensions.map((d) => ({ ...d })));
      } else {
        setName('');
        setDescription('');
        setDimensions(DEFAULT_DIMENSIONS.map((d) => ({ ...d })));
      }
      setNameError('');
    }
  }, [open, editTemplate]);

  const addDimension = () => {
    setDimensions((prev) => [...prev, { name: '', weight: 3, description: '' }]);
  };

  const removeDimension = (index: number) => {
    setDimensions((prev) => prev.filter((_, i) => i !== index));
  };

  const updateDimension = (
    index: number,
    field: keyof CustomTemplate['dimensions'][number],
    value: string | number,
  ) => {
    setDimensions((prev) =>
      prev.map((d, i) => (i === index ? { ...d, [field]: value } : d)),
    );
  };

  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Template name is required');
      return;
    }

    // Filter out dimensions with empty names
    const validDimensions = dimensions.filter((d) => d.name.trim());
    if (validDimensions.length === 0) {
      setNameError('Add at least one dimension');
      return;
    }

    const template: CustomTemplate = {
      id: editTemplate?.id || `custom_${Date.now()}`,
      name: trimmedName,
      description: description.trim(),
      dimensions: validDimensions.map((d) => ({
        name: d.name.trim(),
        weight: d.weight,
        description: d.description.trim(),
      })),
    };

    onSave(template);
  };

  return (
    <Modal open={open} onClose={onClose} size="lg">
      <div className="animate-scale-in">
        {/* Header */}
        <h2 className="text-lg font-semibold text-ink mb-1">
          {editTemplate ? 'Edit Rubric Template' : 'Create Rubric Template'}
        </h2>
        <p className="text-sm text-ink-secondary mb-5">
          Define the evaluation criteria for your interview rubric.
        </p>

        {/* Template name + description */}
        <div className="space-y-3 mb-5">
          <TextField
            label="Template name"
            placeholder="e.g. Senior Engineer Technical"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError('');
            }}
            error={nameError}
          />
          <TextArea
            label="Description (optional)"
            placeholder="Brief description of when to use this template..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>

        {/* Dimensions header */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider">
            Evaluation Dimensions
          </h3>
          <span className="text-xs text-ink-tertiary">
            {dimensions.length} {dimensions.length === 1 ? 'dimension' : 'dimensions'}
          </span>
        </div>

        {/* Dimensions list */}
        <div className="space-y-0 mb-4 max-h-[340px] overflow-y-auto">
          {dimensions.map((dim, index) => (
            <div
              key={index}
              className={`
                flex items-start gap-3 py-3 px-1
                ${index < dimensions.length - 1 ? 'border-b border-border' : ''}
              `}
            >
              {/* Dimension content */}
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-3">
                  {/* Name input */}
                  <TextField
                    placeholder="Dimension name"
                    value={dim.name}
                    onChange={(e) => updateDimension(index, 'name', e.target.value)}
                    className="flex-1"
                  />

                  {/* Weight selector */}
                  <div className="flex-shrink-0 w-[140px]">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-ink-tertiary whitespace-nowrap">
                        Weight
                      </label>
                      <div className="relative flex-1">
                        <select
                          value={dim.weight}
                          onChange={(e) =>
                            updateDimension(index, 'weight', Number(e.target.value))
                          }
                          className="
                            w-full border border-border rounded-[--radius-button] px-2 py-2 text-xs
                            bg-surface text-ink appearance-none pr-6
                            focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent
                          "
                        >
                          {[1, 2, 3, 4, 5].map((w) => (
                            <option key={w} value={w}>
                              {w} - {WEIGHT_LABELS[w]}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Description (optional inline) */}
                <input
                  type="text"
                  placeholder="Optional description..."
                  value={dim.description}
                  onChange={(e) => updateDimension(index, 'description', e.target.value)}
                  className="
                    w-full border border-border rounded-[--radius-chip] px-3 py-1.5 text-xs
                    bg-surface text-ink-secondary placeholder:text-ink-tertiary
                    focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent
                  "
                />
              </div>

              {/* Remove button */}
              <button
                type="button"
                onClick={() => removeDimension(index)}
                className="
                  flex-shrink-0 mt-2 p-1 rounded-[--radius-chip]
                  text-ink-tertiary hover:text-error hover:bg-red-50
                  transition-colors cursor-pointer
                "
                aria-label={`Remove ${dim.name || 'dimension'}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}

          {dimensions.length === 0 && (
            <div className="text-center py-6 text-sm text-ink-tertiary">
              No dimensions added yet. Click the button below to add one.
            </div>
          )}
        </div>

        {/* Add dimension button */}
        <button
          type="button"
          onClick={addDimension}
          className="
            w-full flex items-center justify-center gap-2 py-2.5
            border-2 border-dashed border-border rounded-[--radius-button]
            text-sm text-ink-secondary font-medium
            hover:border-accent hover:text-accent
            transition-colors cursor-pointer mb-5
          "
        >
          <Plus className="w-4 h-4" />
          Add Dimension
        </button>

        {/* Footer actions */}
        <div className="flex justify-end gap-3 pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            Save Template
          </Button>
        </div>
      </div>
    </Modal>
  );
}
