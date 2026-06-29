/**
 * GlassScene — full-bleed dark "midnight vibrancy" backdrop for the liquid-glass UI.
 *
 * Renders an animated dark gradient scene with three soft, slowly-drifting blurred
 * blobs (indigo / cyan / magenta) so the glass panels layered above have something to
 * refract. Place inside a `position: relative` container; it absolutely fills it and is
 * non-interactive (pointer-events: none).
 */
export function GlassScene({ className = '' }: { className?: string }) {
  return (
    <div className={`glass-scene ${className}`} aria-hidden="true">
      <div
        className="glass-blob"
        style={{
          width: 340,
          height: 340,
          left: -70,
          top: -90,
          background: 'radial-gradient(circle, #6a5bff 0%, rgba(106,91,255,0) 70%)',
        }}
      />
      <div
        className="glass-blob"
        style={{
          width: 300,
          height: 300,
          right: -60,
          top: 30,
          background: 'radial-gradient(circle, #19c6e0 0%, rgba(25,198,224,0) 70%)',
          animationDelay: '-5s',
        }}
      />
      <div
        className="glass-blob"
        style={{
          width: 280,
          height: 280,
          left: '40%',
          bottom: -110,
          background: 'radial-gradient(circle, #c655ff 0%, rgba(198,85,255,0) 70%)',
          animationDelay: '-9s',
        }}
      />
    </div>
  );
}
