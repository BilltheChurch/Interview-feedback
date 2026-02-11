/* global desktopAPI */

const TARGET_SAMPLE_RATE = 16000;
const TARGET_CHANNELS = 1;
const TARGET_FORMAT = "pcm_s16le";
const CHUNK_SAMPLES = 16000; // 1 second @ 16kHz mono
const RECORDING_TIMEOUT_MS = 30_000;

const appInfoEl = document.querySelector("#app-info");
const meetingIdEl = document.querySelector("#meeting-id");
const wsUrlEl = document.querySelector("#ws-url");
const meterBarEl = document.querySelector("#meter-bar");
const meterValueEl = document.querySelector("#meter-value");
const uploadStatusEl = document.querySelector("#upload-status");
const resultJsonEl = document.querySelector("#result-json");
const logsEl = document.querySelector("#logs");
const playbackEl = document.querySelector("#playback");
const selectedFileEl = document.querySelector("#selected-file");

const btnInitStream = document.querySelector("#btn-init-stream");
const btnStartRecording = document.querySelector("#btn-start-recording");
const btnStopRecording = document.querySelector("#btn-stop-recording");
const btnOpenLastFile = document.querySelector("#btn-open-last-file");
const btnPickFile = document.querySelector("#btn-pick-file");
const btnNormalizeFile = document.querySelector("#btn-normalize-file");
const btnStartUpload = document.querySelector("#btn-start-upload");
const btnStopUpload = document.querySelector("#btn-stop-upload");
const btnFetchUploadStatus = document.querySelector("#btn-fetch-upload-status");

let mediaStream;
let mediaRecorder;
let recordingStopTimer;
let audioChunks = [];
let playbackBlobUrl = "";
let selectedInputFilePath = "";
let lastOutputPath = "";

let audioContext;
let analyserNode;
let scriptProcessorNode;
let silenceGainNode;
let meterFrameId;

let uploadSocket;
let uploadSocketReady = false;
let uploadSeq = 0;
let uploadAckCount = 0;
let uploadMissingCount = 0;
let uploadSentCount = 0;
let uploadDroppedCount = 0;
let uploadQueue = [];
let uploadQueueSamples = 0;
let uploadStartedAtMs = 0;

function logLine(message) {
  const stamp = new Date().toISOString();
  logsEl.textContent = `[${stamp}] ${message}\n${logsEl.textContent}`.slice(0, 16_000);
}

function meetingIdValue() {
  return meetingIdEl.value.trim() || "local-selfcheck";
}

function setResultPayload(payload) {
  resultJsonEl.textContent = JSON.stringify(payload, null, 2);
}

function setUploadStatus(message) {
  uploadStatusEl.textContent = message;
}

function clearRecordingTimer() {
  if (recordingStopTimer) {
    clearTimeout(recordingStopTimer);
    recordingStopTimer = null;
  }
}

function updateButtons() {
  const streamReady = Boolean(mediaStream);
  const recording = Boolean(mediaRecorder && mediaRecorder.state === "recording");
  const uploadActive = Boolean(uploadSocket);

  btnStartRecording.disabled = !streamReady || recording;
  btnStopRecording.disabled = !recording;
  btnStartUpload.disabled = !streamReady || uploadActive;
  btnStopUpload.disabled = !uploadActive;
  btnFetchUploadStatus.disabled = !uploadActive;
  btnOpenLastFile.disabled = !lastOutputPath;
  btnNormalizeFile.disabled = !selectedInputFilePath;
}

function updateMeterLoop() {
  if (!analyserNode) return;

  const sampleArray = new Uint8Array(analyserNode.fftSize);
  analyserNode.getByteTimeDomainData(sampleArray);

  let sum = 0;
  for (let i = 0; i < sampleArray.length; i += 1) {
    const centered = (sampleArray[i] - 128) / 128;
    sum += centered * centered;
  }

  const rms = Math.sqrt(sum / sampleArray.length);
  const percent = Math.min(100, Math.max(0, Math.round(rms * 220)));
  meterBarEl.style.width = `${percent}%`;
  meterValueEl.textContent = `${percent}%`;

  meterFrameId = window.requestAnimationFrame(updateMeterLoop);
}

function downsampleBuffer(input, inputRate, outputRate) {
  if (!Number.isFinite(inputRate) || inputRate <= 0) {
    throw new Error(`invalid input sample rate: ${inputRate}`);
  }

  if (inputRate === outputRate) {
    return input.slice();
  }

  if (inputRate < outputRate) {
    throw new Error(`input sample rate ${inputRate} is below target ${outputRate}`);
  }

  const ratio = inputRate / outputRate;
  const outLength = Math.round(input.length / ratio);
  const out = new Float32Array(outLength);

  let outOffset = 0;
  let inOffset = 0;
  while (outOffset < out.length) {
    const nextInOffset = Math.round((outOffset + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let i = inOffset; i < nextInOffset && i < input.length; i += 1) {
      sum += input[i];
      count += 1;
    }
    out[outOffset] = count > 0 ? sum / count : 0;
    outOffset += 1;
    inOffset = nextInOffset;
  }

  return out;
}

function float32ToInt16(floatData) {
  const int16 = new Int16Array(floatData.length);
  for (let i = 0; i < floatData.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, floatData[i]));
    int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return int16;
}

function int16ToBase64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const step = 0x2000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return window.btoa(binary);
}

function queueUploadSamples(samples) {
  if (samples.length === 0) return;
  uploadQueue.push({ samples, offset: 0 });
  uploadQueueSamples += samples.length;
}

function dequeueUploadSamples(targetCount) {
  if (uploadQueueSamples < targetCount) {
    return null;
  }

  const merged = new Int16Array(targetCount);
  let writeOffset = 0;

  while (writeOffset < targetCount) {
    const head = uploadQueue[0];
    const available = head.samples.length - head.offset;
    const needs = targetCount - writeOffset;
    const toCopy = Math.min(available, needs);

    merged.set(head.samples.subarray(head.offset, head.offset + toCopy), writeOffset);
    head.offset += toCopy;
    writeOffset += toCopy;
    uploadQueueSamples -= toCopy;

    if (head.offset >= head.samples.length) {
      uploadQueue.shift();
    }
  }

  return merged;
}

function resetUploadQueue() {
  uploadQueue = [];
  uploadQueueSamples = 0;
}

function handleAudioProcess(event) {
  if (!uploadSocket || !uploadSocketReady) return;

  const inputBuffer = event.inputBuffer;
  const channelCount = inputBuffer.numberOfChannels || 1;
  const inputLength = inputBuffer.getChannelData(0).length;
  const mono = new Float32Array(inputLength);

  if (channelCount === 1) {
    mono.set(inputBuffer.getChannelData(0));
  } else {
    for (let c = 0; c < channelCount; c += 1) {
      const channel = inputBuffer.getChannelData(c);
      for (let i = 0; i < inputLength; i += 1) {
        mono[i] += channel[i] / channelCount;
      }
    }
  }

  const downsampled = downsampleBuffer(mono, audioContext.sampleRate, TARGET_SAMPLE_RATE);
  const pcm16 = float32ToInt16(downsampled);
  queueUploadSamples(pcm16);

  while (uploadQueueSamples >= CHUNK_SAMPLES && uploadSocket && uploadSocketReady) {
    const oneSecond = dequeueUploadSamples(CHUNK_SAMPLES);
    if (!oneSecond) break;

    uploadSeq += 1;
    const contentB64 = int16ToBase64(oneSecond);
    const message = {
      type: "chunk",
      meeting_id: meetingIdValue(),
      seq: uploadSeq,
      timestamp_ms: Date.now(),
      sample_rate: TARGET_SAMPLE_RATE,
      channels: TARGET_CHANNELS,
      format: TARGET_FORMAT,
      content_b64: contentB64
    };

    try {
      uploadSocket.send(JSON.stringify(message));
      uploadSentCount += 1;
    } catch (error) {
      uploadDroppedCount += 1;
      logLine(`WS send failed for seq=${uploadSeq}: ${error.message}`);
      break;
    }
  }
}

async function initMicStream() {
  if (mediaStream) return;

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    video: false
  });

  audioContext = new window.AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);

  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 2048;
  source.connect(analyserNode);
  updateMeterLoop();

  scriptProcessorNode = audioContext.createScriptProcessor(4096, 1, 1);
  scriptProcessorNode.onaudioprocess = handleAudioProcess;
  silenceGainNode = audioContext.createGain();
  silenceGainNode.gain.value = 0;
  source.connect(scriptProcessorNode);
  scriptProcessorNode.connect(silenceGainNode);
  silenceGainNode.connect(audioContext.destination);
}

function makeMediaRecorder(stream) {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4"
  ];

  for (const mimeType of candidates) {
    if (window.MediaRecorder.isTypeSupported(mimeType)) {
      return new window.MediaRecorder(stream, { mimeType });
    }
  }

  return new window.MediaRecorder(stream);
}

async function stopRecordingInternal(reason = "manual-stop") {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  logLine(`Stopping recording (${reason})...`);

  await new Promise((resolve) => {
    mediaRecorder.addEventListener("stop", () => resolve(), { once: true });
    mediaRecorder.stop();
  });

  clearRecordingTimer();
  updateButtons();

  if (audioChunks.length === 0) {
    logLine("No audio chunk received.");
    return;
  }

  const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
  if (playbackBlobUrl) {
    URL.revokeObjectURL(playbackBlobUrl);
  }
  playbackBlobUrl = URL.createObjectURL(blob);
  playbackEl.src = playbackBlobUrl;

  const arrayBuffer = await blob.arrayBuffer();
  const response = await desktopAPI.finalizeRecording({
    rawBytes: arrayBuffer,
    mimeType: blob.type,
    meetingId: meetingIdValue()
  });

  setResultPayload(response);
  lastOutputPath = response.normalizedPath || "";
  updateButtons();

  const validationPassed = Boolean(response.validation?.passed);
  logLine(
    validationPassed
      ? `Recording normalized: ${response.normalizedPath}`
      : `Recording normalized but failed validation: ${response.normalizedPath}`
  );
}

async function startRecording() {
  await initMicStream();
  audioChunks = [];
  mediaRecorder = makeMediaRecorder(mediaStream);

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      audioChunks.push(event.data);
    }
  });

  mediaRecorder.start(1000);
  clearRecordingTimer();
  recordingStopTimer = setTimeout(() => {
    stopRecordingInternal("auto-30s");
  }, RECORDING_TIMEOUT_MS);

  updateButtons();
  logLine(`Recording started; mimeType=${mediaRecorder.mimeType || "default"}`);
}

function normalizeWsBaseUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("WS URL is empty");
  }

  const base = trimmed.replace(/\/+$/, "");
  if (!base.startsWith("ws://") && !base.startsWith("wss://")) {
    throw new Error("WS URL must start with ws:// or wss://");
  }
  return base;
}

function wsSessionUrl() {
  return `${normalizeWsBaseUrl(wsUrlEl.value)}/${encodeURIComponent(meetingIdValue())}`;
}

function closeUploadSocket(reason) {
  if (!uploadSocket) return;

  try {
    uploadSocket.send(JSON.stringify({ type: "close", reason }));
  } catch {
    // noop
  }

  try {
    uploadSocket.close(1000, reason.slice(0, 120));
  } catch {
    // noop
  }

  uploadSocket = undefined;
  uploadSocketReady = false;
  resetUploadQueue();
  updateButtons();
}

async function startUpload() {
  await initMicStream();
  if (uploadSocket) {
    throw new Error("upload already started");
  }

  uploadSeq = 0;
  uploadAckCount = 0;
  uploadMissingCount = 0;
  uploadSentCount = 0;
  uploadDroppedCount = 0;
  resetUploadQueue();
  uploadStartedAtMs = Date.now();

  const endpoint = wsSessionUrl();
  logLine(`Connecting WS: ${endpoint}`);
  setUploadStatus(`Connecting: ${endpoint}`);

  const ws = new window.WebSocket(endpoint);
  uploadSocket = ws;
  updateButtons();

  ws.addEventListener("open", () => {
    if (uploadSocket !== ws) return;
    uploadSocketReady = true;
    ws.send(
      JSON.stringify({
        type: "hello",
        meeting_id: meetingIdValue(),
        sample_rate: TARGET_SAMPLE_RATE,
        channels: TARGET_CHANNELS,
        format: TARGET_FORMAT
      })
    );
    setUploadStatus("Upload active: waiting for chunk ACKs...");
    logLine("WS connected; upload started.");
  });

  ws.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      logLine(`WS message (text): ${event.data}`);
      return;
    }

    if (payload.type === "ack") {
      uploadAckCount += 1;
      uploadMissingCount = Number(payload.missing_count || uploadMissingCount);
      setUploadStatus(
        `Live upload: sent=${uploadSentCount}, ack=${uploadAckCount}, missing=${uploadMissingCount}, last_seq=${payload.seq}`
      );
      return;
    }

    if (payload.type === "status") {
      setResultPayload(payload);
      logLine(`WS status: ${JSON.stringify(payload)}`);
      return;
    }

    if (payload.type === "error") {
      logLine(`WS server error: ${payload.detail}`);
      setResultPayload(payload);
      return;
    }

    logLine(`WS message: ${JSON.stringify(payload)}`);
  });

  ws.addEventListener("close", (event) => {
    if (uploadSocket !== ws) return;

    const elapsedSec = ((Date.now() - uploadStartedAtMs) / 1000).toFixed(1);
    setUploadStatus(
      `Upload closed(code=${event.code}): sent=${uploadSentCount}, ack=${uploadAckCount}, dropped=${uploadDroppedCount}, elapsed=${elapsedSec}s`
    );
    logLine(`WS closed code=${event.code} reason=${event.reason || "none"}`);

    uploadSocket = undefined;
    uploadSocketReady = false;
    resetUploadQueue();
    updateButtons();
  });

  ws.addEventListener("error", () => {
    logLine("WS error event received.");
    setUploadStatus("Upload error. Check gateway URL and worker logs.");
  });
}

function stopUpload() {
  if (!uploadSocket) return;
  closeUploadSocket("client-stop");
}

function fetchUploadStatus() {
  if (!uploadSocket || !uploadSocketReady) {
    throw new Error("upload socket is not ready");
  }

  uploadSocket.send(JSON.stringify({ type: "status" }));
}

async function renderRuntimeInfo() {
  try {
    const info = await desktopAPI.getAppInfo();
    appInfoEl.textContent =
      `${info.appName} v${info.appVersion} | Electron ${info.electronVersion} | ` +
      `${info.target.sampleRate}Hz/${info.target.channels}ch/${info.target.codec}`;
  } catch (error) {
    appInfoEl.textContent = `Runtime info failed: ${error.message}`;
  }
}

async function pickAudioFile() {
  const result = await desktopAPI.pickFile();
  if (result.canceled) {
    logLine("File picker canceled.");
    return;
  }

  selectedInputFilePath = result.filePath;
  selectedFileEl.textContent = selectedInputFilePath;
  updateButtons();
  logLine(`Selected file: ${selectedInputFilePath}`);
}

async function normalizeSelectedFile() {
  if (!selectedInputFilePath) return;
  const response = await desktopAPI.normalizeFile({
    inputPath: selectedInputFilePath,
    meetingId: meetingIdValue()
  });

  setResultPayload(response);
  lastOutputPath = response.normalizedPath || "";
  updateButtons();

  const validationPassed = Boolean(response.validation?.passed);
  logLine(
    validationPassed
      ? `File normalized: ${response.normalizedPath}`
      : `File normalized but failed validation: ${response.normalizedPath}`
  );
}

async function openLastFile() {
  if (!lastOutputPath) return;
  const result = await desktopAPI.openPath(lastOutputPath);
  if (!result.ok) {
    throw new Error(result.error || "open path failed");
  }
}

function bindEvents() {
  btnInitStream.addEventListener("click", async () => {
    try {
      await initMicStream();
      updateButtons();
      logLine("Microphone stream initialized.");
    } catch (error) {
      logLine(`Microphone init failed: ${error.message}`);
      setResultPayload({ error: error.message });
    }
  });

  btnStartRecording.addEventListener("click", async () => {
    try {
      await startRecording();
    } catch (error) {
      logLine(`Start recording failed: ${error.message}`);
      setResultPayload({ error: error.message });
      updateButtons();
    }
  });

  btnStopRecording.addEventListener("click", async () => {
    try {
      await stopRecordingInternal("manual-stop");
    } catch (error) {
      logLine(`Stop recording failed: ${error.message}`);
      setResultPayload({ error: error.message });
      updateButtons();
    }
  });

  btnPickFile.addEventListener("click", async () => {
    try {
      await pickAudioFile();
    } catch (error) {
      logLine(`Pick file failed: ${error.message}`);
      setResultPayload({ error: error.message });
    }
  });

  btnNormalizeFile.addEventListener("click", async () => {
    try {
      await normalizeSelectedFile();
    } catch (error) {
      logLine(`Normalize file failed: ${error.message}`);
      setResultPayload({ error: error.message });
    }
  });

  btnOpenLastFile.addEventListener("click", async () => {
    try {
      await openLastFile();
    } catch (error) {
      logLine(`Open file failed: ${error.message}`);
      setResultPayload({ error: error.message });
    }
  });

  btnStartUpload.addEventListener("click", async () => {
    try {
      await startUpload();
      updateButtons();
    } catch (error) {
      logLine(`Start upload failed: ${error.message}`);
      setResultPayload({ error: error.message });
      setUploadStatus("Upload not started.");
      closeUploadSocket("start-upload-failed");
    }
  });

  btnStopUpload.addEventListener("click", () => {
    try {
      stopUpload();
    } catch (error) {
      logLine(`Stop upload failed: ${error.message}`);
      setResultPayload({ error: error.message });
    }
  });

  btnFetchUploadStatus.addEventListener("click", () => {
    try {
      fetchUploadStatus();
    } catch (error) {
      logLine(`Fetch upload status failed: ${error.message}`);
      setResultPayload({ error: error.message });
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  updateButtons();
  await renderRuntimeInfo();
  bindEvents();
});

window.addEventListener("beforeunload", () => {
  clearRecordingTimer();

  if (meterFrameId) {
    window.cancelAnimationFrame(meterFrameId);
  }

  if (uploadSocket) {
    closeUploadSocket("window-close");
  }

  if (audioContext) {
    audioContext.close();
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }

  if (playbackBlobUrl) {
    URL.revokeObjectURL(playbackBlobUrl);
  }
});
