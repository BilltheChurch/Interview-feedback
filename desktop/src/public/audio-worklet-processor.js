/**
 * AudioWorklet processor for real-time PCM chunk generation.
 * Runs on the audio rendering thread for glitch-free processing.
 *
 * Accumulates float32 samples and emits 1-second PCM16 chunks
 * via MessagePort to the main thread.
 */
class ChunkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Target: 16kHz mono, 1 second = 16000 samples
    this._targetRate = options.processorOptions?.targetRate || 16000;
    this._chunkSamples = this._targetRate; // 1 second
    this._buffer = new Float32Array(0);
    this._sampleRate = sampleRate; // AudioWorklet global from AudioWorkletGlobalScope
  }

  process(inputs, _outputs, _parameters) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true; // keep processor alive
    }

    // Mix all channels to mono
    const numChannels = input.length;
    const frameLength = input[0].length;
    let channelData;

    if (numChannels === 1) {
      channelData = input[0];
    } else {
      channelData = new Float32Array(frameLength);
      for (let c = 0; c < numChannels; c++) {
        const ch = input[c];
        for (let i = 0; i < frameLength; i++) {
          channelData[i] += ch[i] / numChannels;
        }
      }
    }

    // Calculate RMS for level metering (on original sample rate data)
    let sumSq = 0;
    for (let i = 0; i < channelData.length; i++) {
      sumSq += channelData[i] * channelData[i];
    }
    const rms = Math.sqrt(sumSq / channelData.length);

    // Downsample if needed
    const downsampled = this._downsample(channelData, this._sampleRate, this._targetRate);

    // Accumulate into buffer
    const merged = new Float32Array(this._buffer.length + downsampled.length);
    merged.set(this._buffer);
    merged.set(downsampled, this._buffer.length);
    this._buffer = merged;

    // Emit complete 1-second chunks
    while (this._buffer.length >= this._chunkSamples) {
      const chunk = this._buffer.slice(0, this._chunkSamples);
      this._buffer = this._buffer.slice(this._chunkSamples);

      // Convert float32 to int16 (matching float32ToInt16 in AudioService.ts)
      const int16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Transfer ownership (zero-copy) — buffer is unusable after this
      this.port.postMessage({ type: 'chunk', pcm: int16.buffer, rms }, [int16.buffer]);
    }

    // Send level update regardless of chunk emission
    this.port.postMessage({ type: 'level', rms });

    return true; // keep processor alive
  }

  /**
   * Linear interpolation downsampler — matches the averaging approach in
   * AudioService.ts's downsampleBuffer but uses lerp for per-sample precision.
   */
  _downsample(buffer, fromRate, toRate) {
    if (fromRate === toRate) return buffer;
    const ratio = fromRate / toRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, buffer.length - 1);
      const frac = srcIndex - low;
      result[i] = buffer[low] * (1 - frac) + buffer[high] * frac;
    }
    return result;
  }
}

registerProcessor('chunk-processor', ChunkProcessor);
