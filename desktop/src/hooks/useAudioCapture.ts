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
  error: string | null;
};

/* ── Constants ─────────────────────────────── */

const LEVEL_POLL_MS = 100;
const FFT_SIZE = 2048;

/* ── Helpers ───────────────────────────────── */

/** Read RMS level (0-100) from an AnalyserNode. */
function readRmsLevel(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i] * buf[i];
  }
  const rms = Math.sqrt(sum / buf.length);
  // Map RMS 0..0.5 → 0..100 with clamp
  return Math.min(100, Math.round(rms * 200));
}

/* ── Hook ──────────────────────────────────── */

export function useAudioCapture(): UseAudioCaptureReturn {
  const [micReady, setMicReady] = useState(false);
  const [systemReady, setSystemReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [levels, setLevels] = useState<AudioLevels>({ mic: 0, system: 0, mixed: 0 });
  const [error, setError] = useState<string | null>(null);

  // Audio graph refs (persist across renders, cleaned up on unmount)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);

  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const systemAnalyserRef = useRef<AnalyserNode | null>(null);
  const mixedAnalyserRef = useRef<AnalyserNode | null>(null);

  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const systemSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const mixGainRef = useRef<GainNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  /* ── Audio graph setup ─────────────────── */

  const ensureAudioGraph = useCallback(() => {
    if (audioCtxRef.current) return audioCtxRef.current;

    const ctx = new AudioContext();

    const mixGain = ctx.createGain();
    mixGain.gain.value = 1;

    const micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = FFT_SIZE;

    const systemAnalyser = ctx.createAnalyser();
    systemAnalyser.fftSize = FFT_SIZE;

    const mixedAnalyser = ctx.createAnalyser();
    mixedAnalyser.fftSize = FFT_SIZE;

    // Mix → mixed analyser (for level metering only)
    mixGain.connect(mixedAnalyser);

    // Silent output: connect graph to destination so Chromium's rendering
    // thread processes all upstream AnalyserNodes (gain=0 → no audible output)
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    mixedAnalyser.connect(silentGain);
    silentGain.connect(ctx.destination);

    audioCtxRef.current = ctx;
    micAnalyserRef.current = micAnalyser;
    systemAnalyserRef.current = systemAnalyser;
    mixedAnalyserRef.current = mixedAnalyser;
    mixGainRef.current = mixGain;
    silentGainRef.current = silentGain;

    return ctx;
  }, []);

  /* ── Level polling ─────────────────────── */

  const startLevelPolling = useCallback(() => {
    if (timerRef.current) return;

    const bufLen = FFT_SIZE;
    const micBuf = new Float32Array(bufLen);
    const sysBuf = new Float32Array(bufLen);
    const mixBuf = new Float32Array(bufLen);

    timerRef.current = setInterval(() => {
      if (!mountedRef.current) return;

      const micLvl = micAnalyserRef.current ? readRmsLevel(micAnalyserRef.current, micBuf) : 0;
      const sysLvl = systemAnalyserRef.current ? readRmsLevel(systemAnalyserRef.current, sysBuf) : 0;
      const mixLvl = mixedAnalyserRef.current ? readRmsLevel(mixedAnalyserRef.current, mixBuf) : 0;

      setLevels({ mic: micLvl, system: sysLvl, mixed: mixLvl });
    }, LEVEL_POLL_MS);
  }, []);

  const stopLevelPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setLevels({ mic: 0, system: 0, mixed: 0 });
  }, []);

  /* ── Public API ─────────────────────────── */

  const initMic = useCallback(async () => {
    try {
      setError(null);
      const ctx = ensureAudioGraph();

      // Resume AudioContext if suspended (browser autoplay policy)
      if (ctx.state === 'suspended') await ctx.resume();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
        video: false,
      });

      const track = stream.getAudioTracks()[0];
      if (!track) {
        stream.getTracks().forEach(t => t.stop());
        throw new Error('Microphone stream has no audio track');
      }

      // Disconnect previous source if any
      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
      }
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(t => t.stop());
      }

      const source = ctx.createMediaStreamSource(stream);
      source.connect(micAnalyserRef.current!);
      source.connect(mixGainRef.current!);

      micSourceRef.current = source;
      micStreamRef.current = stream;

      // Handle track ending unexpectedly
      track.addEventListener('ended', () => {
        if (!mountedRef.current) return;
        setMicReady(false);
        micSourceRef.current?.disconnect();
        micSourceRef.current = null;
        micStreamRef.current = null;
      });

      setMicReady(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Microphone init failed: ${msg}`);
      setMicReady(false);
    }
  }, [ensureAudioGraph]);

  const initSystem = useCallback(async () => {
    try {
      setError(null);
      const ctx = ensureAudioGraph();
      if (ctx.state === 'suspended') await ctx.resume();

      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      const audioTrack = displayStream.getAudioTracks()[0];
      if (!audioTrack) {
        displayStream.getTracks().forEach(t => t.stop());
        throw new Error('Selected source has no system audio track');
      }

      // Disconnect previous
      if (systemSourceRef.current) {
        systemSourceRef.current.disconnect();
      }
      if (systemStreamRef.current) {
        systemStreamRef.current.getTracks().forEach(t => t.stop());
      }
      if (displayStreamRef.current) {
        displayStreamRef.current.getTracks().forEach(t => t.stop());
      }

      // Keep video track alive for capture session but disable rendering
      displayStream.getVideoTracks().forEach(t => { t.enabled = false; });

      const audioStream = new MediaStream([audioTrack]);
      const source = ctx.createMediaStreamSource(audioStream);
      source.connect(systemAnalyserRef.current!);
      source.connect(mixGainRef.current!);

      systemSourceRef.current = source;
      systemStreamRef.current = audioStream;
      displayStreamRef.current = displayStream;

      audioTrack.addEventListener('ended', () => {
        if (!mountedRef.current) return;
        setSystemReady(false);
        systemSourceRef.current?.disconnect();
        systemSourceRef.current = null;
        systemStreamRef.current = null;
        displayStreamRef.current = null;
      });

      setSystemReady(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // User cancelled the screen picker — not an error
      if (msg.includes('Permission denied') || msg.includes('cancelled') || msg.includes('AbortError')) {
        setError(null);
      } else {
        setError(`System audio init failed: ${msg}`);
      }
      setSystemReady(false);
    }
  }, [ensureAudioGraph]);

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

      // Stop polling
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }

      // Release audio streams
      micSourceRef.current?.disconnect();
      systemSourceRef.current?.disconnect();
      silentGainRef.current?.disconnect();
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      systemStreamRef.current?.getTracks().forEach(t => t.stop());
      displayStreamRef.current?.getTracks().forEach(t => t.stop());

      // Close AudioContext
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close();
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
    error,
  };
}
