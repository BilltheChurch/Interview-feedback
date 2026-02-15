import { useSessionStore } from '../stores/sessionStore';

/* ── Constants ─────────────────────────────── */

const LEVEL_POLL_MS = 100;
const FFT_SIZE = 2048;

/* ── Helpers ───────────────────────────────── */

function readRmsLevel(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i] * buf[i];
  }
  const rms = Math.sqrt(sum / buf.length);
  return Math.min(100, Math.round(rms * 200));
}

/* ── AudioService ──────────────────────────── */

class AudioService {
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private systemStream: MediaStream | null = null;
  private displayStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private systemSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private systemAnalyser: AnalyserNode | null = null;
  private mixedAnalyser: AnalyserNode | null = null;
  private mixGain: GainNode | null = null;
  private silentGain: GainNode | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;

  /* ── Audio graph ─────────────────────────── */

  ensureAudioGraph(): AudioContext {
    if (this.audioCtx) return this.audioCtx;

    const ctx = new AudioContext();

    const mixGain = ctx.createGain();
    mixGain.gain.value = 1;

    const micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = FFT_SIZE;

    const systemAnalyser = ctx.createAnalyser();
    systemAnalyser.fftSize = FFT_SIZE;

    const mixedAnalyser = ctx.createAnalyser();
    mixedAnalyser.fftSize = FFT_SIZE;

    // Mix -> mixed analyser for level metering
    mixGain.connect(mixedAnalyser);

    // Bug A fix: connect to destination via silent gain so Chromium
    // processes the audio graph (rendering thread needs a path to destination)
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    mixedAnalyser.connect(silentGain);
    silentGain.connect(ctx.destination);

    this.audioCtx = ctx;
    this.micAnalyser = micAnalyser;
    this.systemAnalyser = systemAnalyser;
    this.mixedAnalyser = mixedAnalyser;
    this.mixGain = mixGain;
    this.silentGain = silentGain;

    return ctx;
  }

  /* ── Mic init ────────────────────────────── */

  async initMic(): Promise<void> {
    const store = useSessionStore.getState();
    try {
      store.setAudioError(null);
      const ctx = this.ensureAudioGraph();

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
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('Microphone stream has no audio track');
      }

      // Disconnect previous source if any
      if (this.micSource) this.micSource.disconnect();
      if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop());

      const source = ctx.createMediaStreamSource(stream);
      source.connect(this.micAnalyser!);
      source.connect(this.mixGain!);

      this.micSource = source;
      this.micStream = stream;

      track.addEventListener('ended', () => {
        this.micSource?.disconnect();
        this.micSource = null;
        this.micStream = null;
        useSessionStore.getState().setAudioReady('mic', false);
      });

      store.setAudioReady('mic', true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.setAudioError(`Microphone init failed: ${msg}`);
      store.setAudioReady('mic', false);
    }
  }

  /* ── System audio init ───────────────────── */

  async initSystem(): Promise<void> {
    const store = useSessionStore.getState();
    try {
      store.setAudioError(null);
      const ctx = this.ensureAudioGraph();
      if (ctx.state === 'suspended') await ctx.resume();

      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      const audioTrack = displayStream.getAudioTracks()[0];
      if (!audioTrack) {
        displayStream.getTracks().forEach((t) => t.stop());
        throw new Error('Selected source has no system audio track');
      }

      // Disconnect previous
      if (this.systemSource) this.systemSource.disconnect();
      if (this.systemStream) this.systemStream.getTracks().forEach((t) => t.stop());
      if (this.displayStream) this.displayStream.getTracks().forEach((t) => t.stop());

      // Keep video track alive but disabled
      displayStream.getVideoTracks().forEach((t) => {
        t.enabled = false;
      });

      const audioStream = new MediaStream([audioTrack]);
      const source = ctx.createMediaStreamSource(audioStream);
      source.connect(this.systemAnalyser!);
      source.connect(this.mixGain!);

      this.systemSource = source;
      this.systemStream = audioStream;
      this.displayStream = displayStream;

      audioTrack.addEventListener('ended', () => {
        this.systemSource?.disconnect();
        this.systemSource = null;
        this.systemStream = null;
        this.displayStream = null;
        useSessionStore.getState().setAudioReady('system', false);
      });

      store.setAudioReady('system', true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('Permission denied') ||
        msg.includes('cancelled') ||
        msg.includes('AbortError')
      ) {
        store.setAudioError(null);
      } else {
        store.setAudioError(`System audio init failed: ${msg}`);
      }
      store.setAudioReady('system', false);
    }
  }

  /* ── Capture (level polling) ─────────────── */

  startCapture(): void {
    useSessionStore.getState().setIsCapturing(true);

    if (this.levelTimer) return;

    const micBuf = new Float32Array(FFT_SIZE);
    const sysBuf = new Float32Array(FFT_SIZE);
    const mixBuf = new Float32Array(FFT_SIZE);

    this.levelTimer = setInterval(() => {
      const micLvl = this.micAnalyser ? readRmsLevel(this.micAnalyser, micBuf) : 0;
      const sysLvl = this.systemAnalyser ? readRmsLevel(this.systemAnalyser, sysBuf) : 0;
      const mixLvl = this.mixedAnalyser ? readRmsLevel(this.mixedAnalyser, mixBuf) : 0;

      useSessionStore.getState().setAudioLevels({ mic: micLvl, system: sysLvl, mixed: mixLvl });
    }, LEVEL_POLL_MS);
  }

  stopCapture(): void {
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    const store = useSessionStore.getState();
    store.setIsCapturing(false);
    store.setAudioLevels({ mic: 0, system: 0, mixed: 0 });
  }

  /* ── Full teardown ───────────────────────── */

  destroy(): void {
    this.stopCapture();

    this.micSource?.disconnect();
    this.systemSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.systemStream?.getTracks().forEach((t) => t.stop());
    this.displayStream?.getTracks().forEach((t) => t.stop());

    this.micSource = null;
    this.systemSource = null;
    this.micStream = null;
    this.systemStream = null;
    this.displayStream = null;

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
    }
    this.audioCtx = null;
    this.micAnalyser = null;
    this.systemAnalyser = null;
    this.mixedAnalyser = null;
    this.mixGain = null;
    this.silentGain = null;

    const store = useSessionStore.getState();
    store.setAudioReady('mic', false);
    store.setAudioReady('system', false);
  }
}

export const audioService = new AudioService();
