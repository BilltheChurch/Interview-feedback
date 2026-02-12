function concatInt16(chunks, totalLength) {
  const out = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function int16ToBase64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const step = 0x2000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

function createPyannoteWindowBuilder({ sampleRate = 16000, windowMs = 10000, hopMs = 2000 } = {}) {
  const windowSamples = Math.floor((sampleRate * windowMs) / 1000);
  const hopSamples = Math.floor((sampleRate * hopMs) / 1000);
  const queue = [];
  let queueSamples = 0;
  let nextStartSeq = 1;

  function pushSamples({ seq, timestampMs, samples }) {
    if (!(samples instanceof Int16Array) || samples.length === 0) {
      return null;
    }
    queue.push({ seq, timestampMs, samples });
    queueSamples += samples.length;

    if (queueSamples < windowSamples) {
      return null;
    }

    // Build one 10s window, then keep 8s overlap for next 2s hop.
    const chunks = [];
    let collected = 0;
    for (let i = queue.length - 1; i >= 0 && collected < windowSamples; i -= 1) {
      const current = queue[i].samples;
      const need = windowSamples - collected;
      if (current.length <= need) {
        chunks.unshift(current);
        collected += current.length;
      } else {
        chunks.unshift(current.subarray(current.length - need));
        collected += need;
      }
    }

    const merged = concatInt16(chunks, windowSamples);
    const startSeq = nextStartSeq;
    const endSeq = seq;
    nextStartSeq = Math.max(startSeq + Math.round(hopMs / 1000), startSeq + 1);

    // Drop hop samples from the left.
    let toDrop = hopSamples;
    while (toDrop > 0 && queue.length > 0) {
      const head = queue[0];
      if (head.samples.length <= toDrop) {
        queue.shift();
        queueSamples -= head.samples.length;
        toDrop -= head.samples.length;
      } else {
        head.samples = head.samples.subarray(toDrop);
        queueSamples -= toDrop;
        toDrop = 0;
      }
    }

    return {
      source: 'edge',
      start_end_ms: [Math.max(0, timestampMs - windowMs), timestampMs],
      window: `${windowMs}ms/${hopMs}ms`,
      sample_rate: sampleRate,
      channels: 1,
      format: 'pcm_s16le',
      seq_range: [startSeq, endSeq],
      content_b64: int16ToBase64(merged)
    };
  }

  function reset() {
    queue.length = 0;
    queueSamples = 0;
    nextStartSeq = 1;
  }

  return {
    pushSamples,
    reset
  };
}

module.exports = {
  createPyannoteWindowBuilder
};
