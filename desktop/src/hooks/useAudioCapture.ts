import { useState, useRef, useCallback, useEffect } from 'react';

/* ── Types ─────────────────────────────────── */

export type AudioLevels = {
  mic: number;    // 0-100
  system: number; // 0-100
  mixed: number;  // 0-100
};

export type UseAudioCaptureReturn = {
  initMic: () => Promise<void>;
  initSystem: () => Promise<void>;
  startCapture: () => void;
  stopCapture: () => void;
  levels: AudioLevels;
  isCapturing: boolean;
  micReady: boolean;
  systemReady: boolean;
};

/* ── Constants ─────────────────────────────── */

const LEVEL_POLL_MS = 100;

/* ── Hook ──────────────────────────────────── */

/**
 * Audio capture hook (mock implementation).
 *
 * Exposes the full lifecycle interface that views consume.
 * The actual WebRTC getUserMedia / getDisplayMedia integration
 * will be ported in a later pass — this version provides mock
 * levels that simulate realistic audio activity so the UI can
 * be developed and tested independently.
 */
export function useAudioCapture(): UseAudioCaptureReturn {
  const [micReady, setMicReady] = useState(false);
  const [systemReady, setSystemReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [levels, setLevels] = useState<AudioLevels>({ mic: 0, system: 0, mixed: 0 });

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  /* -- Mock level simulation -- */
  const startLevelPolling = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      // Simulate fluctuating audio levels with occasional bursts
      const mic = micReady ? Math.round(Math.random() * 60 + 10) : 0;
      const system = systemReady ? Math.round(Math.random() * 50 + 5) : 0;
      const mixed = Math.min(100, Math.round((mic + system) / 2));
      setLevels({ mic, system, mixed });
    }, LEVEL_POLL_MS);
  }, [micReady, systemReady]);

  const stopLevelPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setLevels({ mic: 0, system: 0, mixed: 0 });
  }, []);

  /* ── Public API ─────────────────────────── */

  const initMic = useCallback(async () => {
    // TODO: Replace with navigator.mediaDevices.getUserMedia({ audio: true })
    // and AudioContext + AnalyserNode for real level metering
    setMicReady(true);
  }, []);

  const initSystem = useCallback(async () => {
    // TODO: Replace with navigator.mediaDevices.getDisplayMedia({ audio: true })
    // for system audio capture via Electron desktopCapturer
    setSystemReady(true);
  }, []);

  const startCapture = useCallback(() => {
    setIsCapturing(true);
    startLevelPolling();
  }, [startLevelPolling]);

  const stopCapture = useCallback(() => {
    setIsCapturing(false);
    stopLevelPolling();
  }, [stopLevelPolling]);

  /* ── Cleanup on unmount ─────────────────── */

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return {
    initMic,
    initSystem,
    startCapture,
    stopCapture,
    levels,
    isCapturing,
    micReady,
    systemReady,
  };
}
