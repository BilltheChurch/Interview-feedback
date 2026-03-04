import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Mic, Volume2, AudioLines } from 'lucide-react';
import { AudioMeters } from './AudioMeters';
import { FlowControl, CollapsibleSection } from './StageControls';
import { EnrollmentPanel, ParticipationSignals } from './ParticipantPanel';
import type { Participant } from './types';

export function ContextDrawer({
  open,
  onToggle,
  currentStage,
  onAdvanceStage,
  participants,
  onEnroll,
  onConfirm,
  stages,
  audioLevels,
}: {
  open: boolean;
  onToggle: () => void;
  currentStage: number;
  onAdvanceStage: () => void;
  participants: Participant[];
  onEnroll: (name: string) => void;
  onConfirm: (name: string) => void;
  stages: string[];
  audioLevels: { mic: number; system: number; mixed: number };
}) {
  return (
    <motion.aside
      animate={{ width: open ? 180 : 44 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="shrink-0 border-l border-border bg-surface flex flex-col relative"
    >
      {/* Toggle button */}
      <button
        onClick={onToggle}
        className="absolute top-2 -left-3 w-6 h-6 rounded-full bg-surface border border-border shadow-sm flex items-center justify-center text-ink-tertiary hover:text-ink-secondary hover:bg-surface-hover transition-colors duration-150 z-10"
        title={open ? 'Collapse drawer' : 'Expand drawer'}
        aria-label={open ? 'Collapse drawer' : 'Expand drawer'}
      >
        {open ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
      </button>

      {/* Collapsed icon rail */}
      {!open && (
        <div className="flex flex-col items-center gap-3 py-3 mt-6">
          <Mic className="w-4 h-4 text-ink-tertiary" />
          <Volume2 className="w-4 h-4 text-ink-tertiary" />
          <AudioLines className="w-4 h-4 text-ink-tertiary" />
        </div>
      )}

      {/* Expanded content */}
      {open && (
        <div className="flex-1 overflow-y-auto p-2.5 pt-6 flex flex-col gap-3">
          <CollapsibleSection title="Audio" defaultOpen>
            <AudioMeters mic={audioLevels.mic} system={audioLevels.system} mixed={audioLevels.mixed} />
          </CollapsibleSection>
          <CollapsibleSection title="Flow">
            <FlowControl currentStage={currentStage} onAdvance={onAdvanceStage} stages={stages} />
          </CollapsibleSection>
          <CollapsibleSection title="Speakers" defaultOpen>
            <EnrollmentPanel participants={participants} onEnroll={onEnroll} onConfirm={onConfirm} />
          </CollapsibleSection>
          <CollapsibleSection title="Speaker Activity" defaultOpen>
            <ParticipationSignals participants={participants} />
          </CollapsibleSection>
        </div>
      )}
    </motion.aside>
  );
}
