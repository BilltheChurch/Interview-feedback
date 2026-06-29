/**
 * GlassScene — clean light backdrop for the liquid-glass UI.
 *
 * A near-flat light wash (set in `.glass-scene`) with a single, very faint, slowly
 * drifting tangerine glow so the frosted panels above have a touch of warmth to refract.
 * Place inside a `position: relative` container; it absolutely fills it and is
 * non-interactive (pointer-events: none).
 */
export function GlassScene({ className = '' }: { className?: string }) {
  return (
    <div className={`glass-scene ${className}`} aria-hidden="true">
      <div
        className="glass-blob"
        style={{
          width: 420,
          height: 420,
          left: -120,
          top: -150,
          background: 'radial-gradient(circle, rgba(255,122,26,0.10) 0%, rgba(255,122,26,0) 70%)',
        }}
      />
    </div>
  );
}
