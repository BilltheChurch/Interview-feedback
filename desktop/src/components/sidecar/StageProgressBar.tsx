export function StageProgressBar({ currentStage, stages }: { currentStage: number; stages: string[] }) {
  return (
    <div className="flex items-center gap-1 px-3 py-1 border-b border-border/50">
      {stages.map((_, i) => (
        <div
          key={i}
          className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
            i <= currentStage ? 'bg-accent' : 'bg-border'
          }`}
        />
      ))}
    </div>
  );
}
