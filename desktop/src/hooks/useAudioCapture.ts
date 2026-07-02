import { useCallback, useEffect } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { audioService } from '../services/AudioService';

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
  error: string | null;
};

/* ── Hook ──────────────────────────────────── */

/**
 * R6-audio: thin wrapper over the singleton AudioService — the SINGLE capture source.
 *
 * This used to be a parallel ~300-line pipeline (own AudioContext + own getUserMedia +
 * duplicated analyser graph), which double-opened the microphone whenever Settings was
 * visited mid-recording and drifted from the session pipeline (rms*200 vs rms*500
 * historically). Now the Settings "test your mic" preview delegates to
 * audioService.startPreview()/stopPreview() and all state (levels / ready flags /
 * errors) is read from the shared session store, so the preview meters always match
 * the in-session AUDIO bars by construction.
 *
 * The return shape is unchanged — consumers (SettingsView) need no edits.
 */
export function useAudioCapture(): UseAudioCaptureReturn {
  const levels = useSessionStore((s) => s.audioLevels);
  const micReady = useSessionStore((s) => s.micReady);
  const systemReady = useSessionStore((s) => s.systemReady);
  const isCapturing = useSessionStore((s) => s.isCapturing);
  const error = useSessionStore((s) => s.audioError);

  // Leaving the consuming view must release the preview microphone. stopPreview is a
  // no-op while a real session is recording, so this can never kill live capture.
  useEffect(() => {
    return () => {
      audioService.stopPreview();
    };
  }, []);

  const initMic = useCallback(() => audioService.startPreview(), []);
  const initSystem = useCallback(() => audioService.initSystem(), []);
  // startPreview is idempotent (existing mic stream + level timer are reused), so the
  // historical initMic() → startCapture() call sequence keeps working.
  const startCapture = useCallback(() => {
    void audioService.startPreview();
  }, []);
  const stopCapture = useCallback(() => {
    audioService.stopPreview();
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
    error,
  };
}
