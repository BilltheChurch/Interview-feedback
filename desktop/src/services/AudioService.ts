import { useSessionStore } from '../stores/sessionStore';
import { wsService } from './WebSocketService';
import type { StreamRole } from '../stores/sessionStore';

/* ── Constants ─────────────────────────────── */

const LEVEL_POLL_MS = 100;
const FFT_SIZE = 2048;
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 16000; // 1 second @ 16kHz mono
const MAX_QUEUE_SAMPLES = CHUNK_SAMPLES * 30; // ~30 seconds of audio
const SCRIPT_PROCESSOR_BUFFER = 4096;

/* ── Audio conversion helpers ─────────────── */

function readRmsLevel(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i] * buf[i];
  }
  const rms = Math.sqrt(sum / buf.length);
  return Math.min(100, Math.round(rms * 200));
}

function downsampleBuffer(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input.slice();
  if (inputRate < outputRate) return input.slice(); // shouldn't happen, but don't crash
  const ratio = inputRate / outputRate;
  const outLength = Math.round(input.length / ratio);
  const out = new Float32Array(outLength);
  let outOffset = 0;
  let inOffset = 0;
  while (outOffset < out.length) {
    const nextInOffset = Math.round((outOffset + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let i = inOffset; i < nextInOffset && i < input.length; i++) {
      sum += input[i];
      count++;
    }
    out[outOffset] = count > 0 ? sum / count : 0;
    outOffset++;
    inOffset = nextInOffset;
  }
  return out;
}

function float32ToInt16(floatData: Float32Array): Int16Array {
  const int16 = new Int16Array(floatData.length);
  for (let i = 0; i < floatData.length; i++) {
    const sample = Math.max(-1, Math.min(1, floatData[i]));
    int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return int16;
}

/* ── Chunk queue for accumulating 1-second PCM chunks ── */

type ChunkQueue = {
  buffers: { samples: Int16Array; offset: number }[];
  totalSamples: number;
  seq: number;
};

function createChunkQueue(): ChunkQueue {
  return { buffers: [], totalSamples: 0, seq: 0 };
}

let _queueDropWarned = false;

function enqueue(q: ChunkQueue, samples: Int16Array): void {
  if (samples.length === 0) return;
  q.buffers.push({ samples, offset: 0 });
  q.totalSamples += samples.length;

  // Enforce queue depth limit — drop oldest samples when queue exceeds ~30s of audio
  if (q.totalSamples > MAX_QUEUE_SAMPLES) {
    if (!_queueDropWarned) {
      console.warn(
        `[AudioService] Queue exceeded ${MAX_QUEUE_SAMPLES} samples — dropping oldest data`,
      );
      _queueDropWarned = true;
    }
    while (q.totalSamples > MAX_QUEUE_SAMPLES && q.buffers.length > 0) {
      const head = q.buffers[0];
      const available = head.samples.length - head.offset;
      const excess = q.totalSamples - MAX_QUEUE_SAMPLES;
      if (available <= excess) {
        // Drop the entire head buffer
        q.totalSamples -= available;
        q.buffers.shift();
      } else {
        // Partially consume the head buffer
        head.offset += excess;
        q.totalSamples -= excess;
      }
    }
  }
}

function dequeue(q: ChunkQueue, count: number): Int16Array | null {
  if (q.totalSamples < count) return null;
  const merged = new Int16Array(count);
  let writeOffset = 0;
  while (writeOffset < count) {
    const head = q.buffers[0];
    const available = head.samples.length - head.offset;
    const needs = count - writeOffset;
    const toCopy = Math.min(available, needs);
    merged.set(head.samples.subarray(head.offset, head.offset + toCopy), writeOffset);
    head.offset += toCopy;
    writeOffset += toCopy;
    q.totalSamples -= toCopy;
    if (head.offset >= head.samples.length) {
      q.buffers.shift();
    }
  }
  return merged;
}

function resetQueue(q: ChunkQueue): void {
  q.buffers = [];
  q.totalSamples = 0;
  q.seq = 0;
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

  // PCM recording nodes
  private micProcessor: ScriptProcessorNode | null = null;
  private systemProcessor: ScriptProcessorNode | null = null;

  // Chunk queues for accumulating 1-second PCM chunks
  private teacherQueue: ChunkQueue = createChunkQueue();
  private studentsQueue: ChunkQueue = createChunkQueue();

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

    // ScriptProcessorNodes for PCM chunk capture
    const micProcessor = ctx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
    micProcessor.onaudioprocess = (event) => {
      this.handleAudioProcess(event, 'teacher');
    };

    const systemProcessor = ctx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
    systemProcessor.onaudioprocess = (event) => {
      this.handleAudioProcess(event, 'students');
    };

    // Connect processors to silent gain so Chromium keeps them alive
    micProcessor.connect(silentGain);
    systemProcessor.connect(silentGain);

    this.audioCtx = ctx;
    this.micAnalyser = micAnalyser;
    this.systemAnalyser = systemAnalyser;
    this.mixedAnalyser = mixedAnalyser;
    this.mixGain = mixGain;
    this.silentGain = silentGain;
    this.micProcessor = micProcessor;
    this.systemProcessor = systemProcessor;

    return ctx;
  }

  /* ── PCM chunk capture ─────────────────── */

  private handleAudioProcess(event: AudioProcessingEvent, role: StreamRole): void {
    if (!this.audioCtx) return;

    const inputBuffer = event.inputBuffer;
    const channelCount = inputBuffer.numberOfChannels || 1;
    const inputLength = inputBuffer.getChannelData(0).length;
    const mono = new Float32Array(inputLength);

    if (channelCount === 1) {
      mono.set(inputBuffer.getChannelData(0));
    } else {
      for (let c = 0; c < channelCount; c++) {
        const channel = inputBuffer.getChannelData(c);
        for (let i = 0; i < inputLength; i++) {
          mono[i] += channel[i] / channelCount;
        }
      }
    }

    const downsampled = downsampleBuffer(mono, this.audioCtx.sampleRate, TARGET_SAMPLE_RATE);
    const pcm16 = float32ToInt16(downsampled);

    const queue = role === 'teacher' ? this.teacherQueue : this.studentsQueue;
    enqueue(queue, pcm16);
    this.processQueue(role, queue);
  }

  private processQueue(role: StreamRole, queue: ChunkQueue): void {
    while (queue.totalSamples >= CHUNK_SAMPLES) {
      const chunk = dequeue(queue, CHUNK_SAMPLES);
      if (!chunk) break;

      queue.seq += 1;
      // Convert Int16Array to ArrayBuffer for WebSocket transmission
      const ab = new ArrayBuffer(chunk.byteLength);
      new Uint8Array(ab).set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      wsService.sendAudioChunk(role, ab, queue.seq);
    }
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
      // Connect to ScriptProcessorNode for PCM chunk capture
      source.connect(this.micProcessor!);

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
      // Connect to ScriptProcessorNode for PCM chunk capture
      source.connect(this.systemProcessor!);

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

  /* ── Capture (level polling + chunk recording) ── */

  startCapture(): void {
    useSessionStore.getState().setIsCapturing(true);

    // Reset chunk queues for fresh recording
    resetQueue(this.teacherQueue);
    resetQueue(this.studentsQueue);

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

    // Reset chunk queues
    resetQueue(this.teacherQueue);
    resetQueue(this.studentsQueue);

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
    this.micProcessor = null;
    this.systemProcessor = null;

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
