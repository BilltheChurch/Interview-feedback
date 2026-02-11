/* global desktopAPI */

const TARGET_SAMPLE_RATE = 16000;
const TARGET_CHANNELS = 1;
const TARGET_FORMAT = "pcm_s16le";
const CHUNK_SAMPLES = 16000; // 1 second @ 16kHz mono
const RECORDING_TIMEOUT_MS = 30_000;
const CAPTURE_STALL_TIMEOUT_MS = 5_000;
const RECOVERY_BACKOFF_MS = [1000, 2000, 5000];
const ECHO_CORR_THRESHOLD = 0.72;
const ECHO_STRONG_CORR_THRESHOLD = 0.90;
const ECHO_MAX_LAG_MS = 180;
const ECHO_TEACHER_STUDENT_RMS_RATIO = 1.35;
const ECHO_TEACHER_DOMINANT_RMS_RATIO = 2.20;
const ECHO_STUDENT_MIN_RMS = 0.010;
const ECHO_RECENT_WINDOW = 120;
const UPLOAD_STREAM_ROLES = ["teacher", "students"];

const appInfoEl = document.querySelector("#app-info");
const meetingIdEl = document.querySelector("#meeting-id");
const apiBaseUrlEl = document.querySelector("#api-base-url");
const wsUrlEl = document.querySelector("#ws-url");
const uploadStatusEl = document.querySelector("#upload-status");
const resultJsonEl = document.querySelector("#result-json");
const liveTranscriptEl = document.querySelector("#live-transcript");
const speakerEventsEl = document.querySelector("#speaker-events");
const logsEl = document.querySelector("#logs");
const playbackEl = document.querySelector("#playback");
const selectedFileEl = document.querySelector("#selected-file");
const interviewerNameEl = document.querySelector("#interviewer-name");
const captureHealthEl = document.querySelector("#capture-health");
const participantListEl = document.querySelector("#participant-list");
const btnParticipantAdd = document.querySelector("#btn-participant-add");
const btnParticipantImport = document.querySelector("#btn-participant-import");
const teamsInterviewerNameEl = document.querySelector("#teams-interviewer-name");
const micAecEl = document.querySelector("#mic-aec");
const micNsEl = document.querySelector("#mic-ns");
const micAgcEl = document.querySelector("#mic-agc");

const meterMicBarEl = document.querySelector("#meter-mic-bar");
const meterMicValueEl = document.querySelector("#meter-mic-value");
const meterSystemBarEl = document.querySelector("#meter-system-bar");
const meterSystemValueEl = document.querySelector("#meter-system-value");
const meterMixedBarEl = document.querySelector("#meter-mixed-bar");
const meterMixedValueEl = document.querySelector("#meter-mixed-value");

const btnInitMic = document.querySelector("#btn-init-mic");
const btnInitSystem = document.querySelector("#btn-init-system");
const btnStartRecording = document.querySelector("#btn-start-recording");
const btnStopRecording = document.querySelector("#btn-stop-recording");
const btnOpenLastFile = document.querySelector("#btn-open-last-file");
const btnPickFile = document.querySelector("#btn-pick-file");
const btnNormalizeFile = document.querySelector("#btn-normalize-file");
const btnStartUpload = document.querySelector("#btn-start-upload");
const btnStopUpload = document.querySelector("#btn-stop-upload");
const btnFetchUploadStatus = document.querySelector("#btn-fetch-upload-status");
const btnSaveSessionConfig = document.querySelector("#btn-save-session-config");
const btnRefreshLive = document.querySelector("#btn-refresh-live");

let micStream;
let systemCaptureStream;
let systemAudioStream;

let mediaRecorder;
let recordingStopTimer;
let audioChunks = [];
let playbackBlobUrl = "";
let selectedInputFilePath = "";
let lastOutputPath = "";

let audioContext;
let micSourceNode;
let systemSourceNode;
let micAnalyserNode;
let systemAnalyserNode;
let mixedAnalyserNode;
let mixGainNode;
let micUploadProcessorNode;
let systemUploadProcessorNode;
let silenceGainNode;
let mixRecordDestinationNode;
let meterFrameId;

const uploadSockets = { teacher: undefined, students: undefined };
const uploadSocketReady = { teacher: false, students: false };
const uploadSeq = { teacher: 0, students: 0 };
const uploadAckCount = { teacher: 0, students: 0 };
const uploadMissingCount = { teacher: 0, students: 0 };
const uploadSentCount = { teacher: 0, students: 0 };
const uploadDroppedCount = { teacher: 0, students: 0 };
const uploadQueue = { teacher: [], students: [] };
const uploadQueueSamples = { teacher: 0, students: 0 };
const uploadStartedAtMs = { teacher: 0, students: 0 };
const uploadClosing = { teacher: false, students: false };
const lastAudioProcessAtMs = { teacher: 0, students: 0 };
const recentStudentsChunks = [];
const recentEchoSuppression = [];
let lastCaptureHealthTickMs = 0;
let suppressAutoRecover = false;
let studentsRecoveryTimer;

const captureMetrics = {
  teacher: {
    capture_state: "idle",
    recover_attempts: 0,
    last_recover_at: null,
    last_recover_error: null,
    echo_suppressed_chunks: 0,
    echo_suppression_recent_rate: 0
  },
  students: {
    capture_state: "idle",
    recover_attempts: 0,
    last_recover_at: null,
    last_recover_error: null
  }
};
let livePollTimer;

function logLine(message) {
  const stamp = new Date().toISOString();
  logsEl.textContent = `[${stamp}] ${message}\n${logsEl.textContent}`.slice(0, 20_000);
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

function isAnyUploadActive() {
  return (
    Boolean(uploadSockets.teacher) ||
    Boolean(uploadSockets.students) ||
    uploadClosing.teacher ||
    uploadClosing.students
  );
}

function clearRecordingTimer() {
  if (recordingStopTimer) {
    clearTimeout(recordingStopTimer);
    recordingStopTimer = null;
  }
}

function stopTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

function updateButtons() {
  const hasMic = Boolean(micStream);
  const hasSystem = Boolean(systemAudioStream);
  const dualReady = hasMic && hasSystem;
  const recording = Boolean(mediaRecorder && mediaRecorder.state === "recording");
  const uploadActive = isAnyUploadActive();

  btnInitMic.disabled = hasMic;
  btnInitSystem.disabled = hasSystem;
  btnStartRecording.disabled = !dualReady || recording;
  btnStopRecording.disabled = !recording;
  btnStartUpload.disabled = !dualReady || uploadActive;
  btnStopUpload.disabled = !uploadActive;
  btnFetchUploadStatus.disabled = !uploadActive;
  btnOpenLastFile.disabled = !lastOutputPath;
  btnNormalizeFile.disabled = !selectedInputFilePath;

  if (!dualReady && !uploadActive) {
    setUploadStatus("Upload not started. Dual input required (mic + system).");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function renderCaptureHealth() {
  if (!captureHealthEl) return;
  const teacher = captureMetrics.teacher;
  const students = captureMetrics.students;
  const lines = [
    `teacher=${teacher.capture_state}, suppressed=${teacher.echo_suppressed_chunks}, recent_rate=${(teacher.echo_suppression_recent_rate * 100).toFixed(1)}%`,
    `students=${students.capture_state}, recover_attempts=${students.recover_attempts}, last_recover_error=${students.last_recover_error || "none"}`
  ];
  captureHealthEl.textContent = lines.join(" | ");
}

function updateCaptureMetrics(role, patch, options = {}) {
  const target = captureMetrics[role];
  Object.assign(target, patch);
  if (!options.skipTimestamp && (patch.capture_state || patch.last_recover_error !== undefined)) {
    target.last_recover_at = nowIso();
  }
  renderCaptureHealth();
  emitCaptureStatus(role);
}

function participantRows() {
  if (!participantListEl) return [];
  return Array.from(participantListEl.querySelectorAll(".participant-row"));
}

function addParticipantRow(initial = {}) {
  if (!participantListEl) return;
  const row = document.createElement("div");
  row.className = "participant-row";
  row.innerHTML = `
    <input class="participant-name" type="text" placeholder="Name" value="${String(initial.name || "").replace(/"/g, "&quot;")}" />
    <input class="participant-email" type="text" placeholder="Email (optional)" value="${String(initial.email || "").replace(/"/g, "&quot;")}" />
    <button type="button" class="participant-remove">Remove</button>
  `;
  const removeBtn = row.querySelector(".participant-remove");
  removeBtn.addEventListener("click", () => {
    row.remove();
  });
  participantListEl.appendChild(row);
}

function importParticipantsFromLines(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!lines.length) return 0;
  for (const line of lines) {
    addParticipantRow({ name: line });
  }
  return lines.length;
}

function parseParticipantsFromUI() {
  const out = [];
  const dedup = new Set();
  for (const row of participantRows()) {
    const nameInput = row.querySelector(".participant-name");
    const emailInput = row.querySelector(".participant-email");
    const name = String(nameInput?.value || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (dedup.has(key)) continue;
    dedup.add(key);
    const email = String(emailInput?.value || "").trim();
    out.push(email ? { name, email } : { name });
  }
  return out;
}

function effectiveInterviewerNames() {
  const interviewerName = String(interviewerNameEl.value || "").trim();
  const teamsInterviewerInput = String(teamsInterviewerNameEl.value || "").trim();
  const teamsInterviewerName = teamsInterviewerInput || interviewerName || undefined;
  return {
    interviewerName: interviewerName || undefined,
    teamsInterviewerName
  };
}

function setMeter(analyser, barEl, valueEl) {
  if (!analyser) {
    barEl.style.width = "0%";
    valueEl.textContent = "0%";
    return 0;
  }

  const sampleArray = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(sampleArray);

  let sum = 0;
  for (let i = 0; i < sampleArray.length; i += 1) {
    const centered = (sampleArray[i] - 128) / 128;
    sum += centered * centered;
  }

  const rms = Math.sqrt(sum / sampleArray.length);
  const percent = Math.min(100, Math.max(0, Math.round(rms * 220)));
  barEl.style.width = `${percent}%`;
  valueEl.textContent = `${percent}%`;
  return percent;
}

function isStudentsSocketWritable() {
  const ws = uploadSockets.students;
  return Boolean(ws && uploadSocketReady.students && ws.readyState === window.WebSocket.OPEN);
}

function scheduleStudentsRecovery(reason) {
  if (studentsRecoveryTimer || suppressAutoRecover) {
    return;
  }
  const attempts = captureMetrics.students.recover_attempts + 1;
  const backoffIdx = Math.min(RECOVERY_BACKOFF_MS.length - 1, Math.max(0, attempts - 1));
  const delay = RECOVERY_BACKOFF_MS[backoffIdx];
  captureMetrics.students.recover_attempts = attempts;
  updateCaptureMetrics("students", {
    capture_state: "recovering",
    last_recover_error: reason
  });
  setUploadStatus(`Recovering system audio in ${Math.round(delay / 1000)}s...`);
  logLine(`System audio recovery scheduled: attempt=${attempts}, delay_ms=${delay}, reason=${reason}`);

  studentsRecoveryTimer = window.setTimeout(async () => {
    studentsRecoveryTimer = undefined;
    try {
      await initSystemStream({ manual: false, reason: `auto-recover:${reason}` });
      updateCaptureMetrics("students", {
        capture_state: "running",
        last_recover_error: null
      });
      setUploadStatus("System audio recovered.");
      logLine("System audio recovered automatically.");
    } catch (error) {
      const detail = error?.message || String(error);
      logLine(`System audio auto-recover failed: ${detail}`);
      updateCaptureMetrics("students", {
        capture_state: "failed",
        last_recover_error: detail
      });
      if (isAnyUploadActive()) {
        scheduleStudentsRecovery(detail);
      }
    }
  }, delay);
}

function checkCaptureHealth(nowMs) {
  if (!isAnyUploadActive()) return;
  if (!systemAudioStream || captureMetrics.students.capture_state === "recovering") return;
  if (!isStudentsSocketWritable()) return;
  const stalledMs = nowMs - (lastAudioProcessAtMs.students || 0);
  if (lastAudioProcessAtMs.students > 0 && stalledMs >= CAPTURE_STALL_TIMEOUT_MS) {
    scheduleStudentsRecovery(`students audio callback stalled ${Math.round(stalledMs)}ms`);
  }
}

function updateMeterLoop() {
  setMeter(micAnalyserNode, meterMicBarEl, meterMicValueEl);
  setMeter(systemAnalyserNode, meterSystemBarEl, meterSystemValueEl);
  setMeter(mixedAnalyserNode, meterMixedBarEl, meterMixedValueEl);
  const nowMs = Date.now();
  if (nowMs - lastCaptureHealthTickMs >= 1000) {
    lastCaptureHealthTickMs = nowMs;
    checkCaptureHealth(nowMs);
  }
  meterFrameId = window.requestAnimationFrame(updateMeterLoop);
}

async function ensureAudioGraph() {
  if (audioContext) return;

  audioContext = new window.AudioContext();

  mixGainNode = audioContext.createGain();
  mixGainNode.gain.value = 1;

  micAnalyserNode = audioContext.createAnalyser();
  micAnalyserNode.fftSize = 2048;

  systemAnalyserNode = audioContext.createAnalyser();
  systemAnalyserNode.fftSize = 2048;

  mixedAnalyserNode = audioContext.createAnalyser();
  mixedAnalyserNode.fftSize = 2048;

  micUploadProcessorNode = audioContext.createScriptProcessor(4096, 1, 1);
  micUploadProcessorNode.onaudioprocess = (event) => {
    handleAudioProcessForRole(event, "teacher");
  };
  systemUploadProcessorNode = audioContext.createScriptProcessor(4096, 1, 1);
  systemUploadProcessorNode.onaudioprocess = (event) => {
    handleAudioProcessForRole(event, "students");
  };

  silenceGainNode = audioContext.createGain();
  silenceGainNode.gain.value = 0;

  mixRecordDestinationNode = audioContext.createMediaStreamDestination();

  mixGainNode.connect(mixedAnalyserNode);
  mixGainNode.connect(mixRecordDestinationNode);
  micUploadProcessorNode.connect(silenceGainNode);
  systemUploadProcessorNode.connect(silenceGainNode);
  silenceGainNode.connect(audioContext.destination);

  updateMeterLoop();
}

function attachMicStream(stream) {
  if (!audioContext || !mixGainNode || !micAnalyserNode || !micUploadProcessorNode) {
    throw new Error("audio graph is not ready for mic stream");
  }

  if (micSourceNode) {
    micSourceNode.disconnect();
  }

  micSourceNode = audioContext.createMediaStreamSource(stream);
  micSourceNode.connect(micAnalyserNode);
  micSourceNode.connect(mixGainNode);
  micSourceNode.connect(micUploadProcessorNode);
}

function attachSystemStream(stream) {
  if (!audioContext || !mixGainNode || !systemAnalyserNode || !systemUploadProcessorNode) {
    throw new Error("audio graph is not ready for system stream");
  }

  if (systemSourceNode) {
    systemSourceNode.disconnect();
  }

  systemSourceNode = audioContext.createMediaStreamSource(stream);
  systemSourceNode.connect(systemAnalyserNode);
  systemSourceNode.connect(mixGainNode);
  systemSourceNode.connect(systemUploadProcessorNode);
}

function releaseMicStream() {
  if (micSourceNode) {
    micSourceNode.disconnect();
    micSourceNode = undefined;
  }

  if (micStream) {
    stopTracks(micStream);
    micStream = undefined;
  }
}

function releaseSystemStream() {
  if (systemSourceNode) {
    systemSourceNode.disconnect();
    systemSourceNode = undefined;
  }

  if (systemAudioStream) {
    stopTracks(systemAudioStream);
    systemAudioStream = undefined;
  }

  if (systemCaptureStream) {
    stopTracks(systemCaptureStream);
    systemCaptureStream = undefined;
  }

  if (studentsRecoveryTimer) {
    window.clearTimeout(studentsRecoveryTimer);
    studentsRecoveryTimer = undefined;
  }
}

async function initMicStream() {
  if (micStream) return;

  await ensureAudioGraph();
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: Boolean(micAecEl?.checked ?? true),
      noiseSuppression: Boolean(micNsEl?.checked ?? true),
      autoGainControl: Boolean(micAgcEl?.checked ?? false)
    },
    video: false
  });

  const micTrack = micStream.getAudioTracks()[0];
  if (!micTrack) {
    releaseMicStream();
    throw new Error("microphone stream does not contain audio track");
  }

  micTrack.addEventListener("ended", () => {
    logLine("Microphone track ended.");
    releaseMicStream();
    resetUploadQueue("teacher");
    updateCaptureMetrics("teacher", {
      capture_state: "failed",
      last_recover_error: "microphone track ended"
    });
    if (isAnyUploadActive()) {
      setUploadStatus("Upload degraded: mic track ended. Click Init Mic to resume teacher stream.");
    }
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopRecordingInternal("mic-track-ended").catch((error) => {
        logLine(`Auto-stop recording failed after mic ended: ${error.message}`);
      });
    }
    setResultPayload({ warning: "Mic track ended. Upload continues for active streams; re-init mic to recover dual stream." });
    updateButtons();
  });

  attachMicStream(micStream);
  lastAudioProcessAtMs.teacher = Date.now();
  updateCaptureMetrics("teacher", {
    capture_state: "running",
    last_recover_error: null
  });
}

async function initSystemStream({ manual = true, reason = "manual-init" } = {}) {
  if (systemAudioStream) return;

  await ensureAudioGraph();
  if (manual) {
    await desktopAPI.clearPreferredCaptureSource();
  }
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true
  });

  const audioTrack = displayStream.getAudioTracks()[0];
  if (!audioTrack) {
    stopTracks(displayStream);
    throw new Error("selected capture source has no system audio track");
  }

  systemCaptureStream = displayStream;
  systemAudioStream = new MediaStream([audioTrack]);

  // Keep video track alive for screen-capture session but avoid rendering cost.
  displayStream.getVideoTracks().forEach((track) => {
    track.enabled = false;
  });

  audioTrack.addEventListener("ended", () => {
    logLine("System audio track ended.");
    releaseSystemStream();
    resetUploadQueue("students");
    updateCaptureMetrics("students", {
      capture_state: "failed",
      last_recover_error: "system audio track ended"
    });
    if (isAnyUploadActive()) {
      setUploadStatus("Upload degraded: system audio ended. Click Init System Audio to resume students stream.");
      scheduleStudentsRecovery("track-ended");
    }
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopRecordingInternal("system-track-ended").catch((error) => {
        logLine(`Auto-stop recording failed after system track ended: ${error.message}`);
      });
    }
    setResultPayload({ warning: "System audio track ended. Upload continues for active streams; re-init system audio to recover dual stream." });
    updateButtons();
  });

  audioTrack.addEventListener("mute", () => {
    logLine("System audio track muted.");
    if (isAnyUploadActive()) {
      scheduleStudentsRecovery("track-muted");
    }
  });

  audioTrack.addEventListener("unmute", () => {
    logLine("System audio track unmuted.");
    updateCaptureMetrics("students", {
      capture_state: "running",
      last_recover_error: null
    });
  });

  attachSystemStream(systemAudioStream);
  if (studentsRecoveryTimer) {
    window.clearTimeout(studentsRecoveryTimer);
    studentsRecoveryTimer = undefined;
  }
  lastAudioProcessAtMs.students = Date.now();
  updateCaptureMetrics("students", {
    capture_state: "running",
    last_recover_error: null
  });
  const sourceInfo = await desktopAPI.getPreferredCaptureSource().catch(() => ({ preferredSourceId: null }));
  logLine(`System audio stream initialized (${reason}); source=${sourceInfo?.preferredSourceId || "unknown"}`);
}

function ensureDualInputReady() {
  if (!micStream || !systemAudioStream) {
    throw new Error("dual input is required: initialize both mic and system audio first");
  }
  if (!mixRecordDestinationNode) {
    throw new Error("audio graph is not initialized");
  }
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

function queueUploadSamples(role, samples) {
  if (samples.length === 0) return;
  uploadQueue[role].push({ samples, offset: 0 });
  uploadQueueSamples[role] += samples.length;
}

function dequeueUploadSamples(role, targetCount) {
  if (uploadQueueSamples[role] < targetCount) {
    return null;
  }

  const merged = new Int16Array(targetCount);
  let writeOffset = 0;

  while (writeOffset < targetCount) {
    const head = uploadQueue[role][0];
    const available = head.samples.length - head.offset;
    const needs = targetCount - writeOffset;
    const toCopy = Math.min(available, needs);

    merged.set(head.samples.subarray(head.offset, head.offset + toCopy), writeOffset);
    head.offset += toCopy;
    writeOffset += toCopy;
    uploadQueueSamples[role] -= toCopy;

    if (head.offset >= head.samples.length) {
      uploadQueue[role].shift();
    }
  }

  return merged;
}

function resetUploadQueue(role) {
  if (!role) {
    UPLOAD_STREAM_ROLES.forEach((item) => resetUploadQueue(item));
    return;
  }
  uploadQueue[role] = [];
  uploadQueueSamples[role] = 0;
}

function renderUploadStatus() {
  const teacher = `teacher sent=${uploadSentCount.teacher},ack=${uploadAckCount.teacher},missing=${uploadMissingCount.teacher}`;
  const students = `students sent=${uploadSentCount.students},ack=${uploadAckCount.students},missing=${uploadMissingCount.students}`;
  setUploadStatus(`Live upload: ${teacher} | ${students}`);
}

function int16Rms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const normalized = samples[i] / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
}

function downsampleInt16ForCorr(samples, targetLength = 400) {
  const output = new Float32Array(targetLength);
  const ratio = samples.length / targetLength;
  for (let i = 0; i < targetLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < samples.length; j += 1) {
      sum += samples[j] / 32768;
      count += 1;
    }
    output[i] = count > 0 ? sum / count : 0;
  }
  return output;
}

function normalizedCrossCorrelation(a, b, maxLagSamples) {
  let bestCorr = -1;
  let bestLag = 0;
  for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += 1) {
    let sumAB = 0;
    let sumA2 = 0;
    let sumB2 = 0;
    for (let i = 0; i < a.length; i += 1) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      const av = a[i];
      const bv = b[j];
      sumAB += av * bv;
      sumA2 += av * av;
      sumB2 += bv * bv;
    }
    if (sumA2 <= 1e-9 || sumB2 <= 1e-9) continue;
    const corr = sumAB / Math.sqrt(sumA2 * sumB2);
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  return {
    corr: Number.isFinite(bestCorr) ? bestCorr : -1,
    lagSamples: bestLag
  };
}

function pushRecentStudentsChunk(samples, timestampMs) {
  recentStudentsChunks.push({
    ts: timestampMs,
    rms: int16Rms(samples),
    corr: downsampleInt16ForCorr(samples)
  });
  while (recentStudentsChunks.length > 8) {
    recentStudentsChunks.shift();
  }
}

function markEchoSuppression(suppressed) {
  recentEchoSuppression.push(suppressed ? 1 : 0);
  while (recentEchoSuppression.length > ECHO_RECENT_WINDOW) {
    recentEchoSuppression.shift();
  }
  const total = recentEchoSuppression.reduce((acc, item) => acc + item, 0);
  captureMetrics.teacher.echo_suppression_recent_rate =
    recentEchoSuppression.length > 0 ? total / recentEchoSuppression.length : 0;
}

function maybeSuppressTeacherChunk(samples, timestampMs) {
  if (recentStudentsChunks.length === 0) {
    markEchoSuppression(false);
    return { chunk: samples, suppressed: false };
  }

  const teacherRms = int16Rms(samples);
  if (teacherRms <= 1e-4) {
    markEchoSuppression(false);
    return { chunk: samples, suppressed: false };
  }

  const teacherCorr = downsampleInt16ForCorr(samples);
  const corrSampleRate = teacherCorr.length; // 1 second window.
  const maxLagSamples = Math.round((ECHO_MAX_LAG_MS / 1000) * corrSampleRate);

  let best = { corr: -1, lagMs: 0, studentRms: 0 };
  for (const candidate of recentStudentsChunks) {
    if (Math.abs(timestampMs - candidate.ts) > 1500) continue;
    const corrResult = normalizedCrossCorrelation(teacherCorr, candidate.corr, maxLagSamples);
    const lagMs = (corrResult.lagSamples / corrSampleRate) * 1000;
    if (corrResult.corr > best.corr) {
      best = {
        corr: corrResult.corr,
        lagMs,
        studentRms: candidate.rms
      };
    }
  }

  const hasStudentEnergy = best.studentRms >= ECHO_STUDENT_MIN_RMS;
  const ratioThreshold = best.studentRms > 0 ? best.studentRms * ECHO_TEACHER_STUDENT_RMS_RATIO : 0;
  const teacherDominant =
    best.studentRms > 0 && teacherRms >= best.studentRms * ECHO_TEACHER_DOMINANT_RMS_RATIO;
  const hardLeak =
    hasStudentEnergy &&
    best.corr >= ECHO_STRONG_CORR_THRESHOLD &&
    Math.abs(best.lagMs) <= ECHO_MAX_LAG_MS;
  const softLeak =
    hasStudentEnergy &&
    best.corr >= ECHO_CORR_THRESHOLD &&
    Math.abs(best.lagMs) <= ECHO_MAX_LAG_MS &&
    teacherRms <= ratioThreshold;
  const shouldSuppress = !teacherDominant && (hardLeak || softLeak);

  markEchoSuppression(shouldSuppress);
  if (!shouldSuppress) {
    return { chunk: samples, suppressed: false };
  }

  captureMetrics.teacher.echo_suppressed_chunks += 1;
  updateCaptureMetrics(
    "teacher",
    {
      echo_suppressed_chunks: captureMetrics.teacher.echo_suppressed_chunks,
      echo_suppression_recent_rate: captureMetrics.teacher.echo_suppression_recent_rate
    },
    { skipTimestamp: true }
  );
  const rmsRatio = best.studentRms > 0 ? teacherRms / best.studentRms : Number.POSITIVE_INFINITY;
  const mode = hardLeak ? "hard" : "soft";
  logLine(
    `Teacher echo suppressed (${mode}): corr=${best.corr.toFixed(3)} lag_ms=${Math.round(best.lagMs)} ` +
      `teacher_rms=${teacherRms.toFixed(4)} student_rms=${best.studentRms.toFixed(4)} ratio=` +
      `${Number.isFinite(rmsRatio) ? rmsRatio.toFixed(2) : "inf"}`
  );
  return { chunk: new Int16Array(samples.length), suppressed: true };
}

function emitCaptureStatus(role) {
  const ws = uploadSockets[role];
  if (!ws || ws.readyState !== window.WebSocket.OPEN || !uploadSocketReady[role]) {
    return;
  }
  const teacherPayload = {
    capture_state: captureMetrics.teacher.capture_state,
    echo_suppressed_chunks: captureMetrics.teacher.echo_suppressed_chunks,
    echo_suppression_recent_rate: captureMetrics.teacher.echo_suppression_recent_rate
  };
  const studentsPayload = {
    capture_state: captureMetrics.students.capture_state,
    recover_attempts: captureMetrics.students.recover_attempts,
    last_recover_at: captureMetrics.students.last_recover_at,
    last_recover_error: captureMetrics.students.last_recover_error
  };
  const payload =
    role === "teacher"
      ? teacherPayload
      : studentsPayload;
  try {
    ws.send(
      JSON.stringify({
        type: "capture_status",
        stream_role: role,
        payload
      })
    );
  } catch (error) {
    logLine(`capture_status send failed (${role}): ${error.message}`);
  }
}

function processUploadQueue(role) {
  const ws = uploadSockets[role];
  if (!ws || ws.readyState !== window.WebSocket.OPEN || !uploadSocketReady[role]) return;

  while (uploadQueueSamples[role] >= CHUNK_SAMPLES) {
    const rawChunk = dequeueUploadSamples(role, CHUNK_SAMPLES);
    if (!rawChunk) break;

    const timestampMs = Date.now();
    let oneSecond = rawChunk;
    if (role === "teacher") {
      const result = maybeSuppressTeacherChunk(rawChunk, timestampMs);
      oneSecond = result.chunk;
    } else if (role === "students") {
      pushRecentStudentsChunk(rawChunk, timestampMs);
    }

    uploadSeq[role] += 1;
    const contentB64 = int16ToBase64(oneSecond);
    const message = {
      type: "chunk",
      stream_role: role,
      meeting_id: meetingIdValue(),
      seq: uploadSeq[role],
      timestamp_ms: timestampMs,
      sample_rate: TARGET_SAMPLE_RATE,
      channels: TARGET_CHANNELS,
      format: TARGET_FORMAT,
      content_b64: contentB64
    };

    try {
      ws.send(JSON.stringify(message));
      uploadSentCount[role] += 1;
      emitCaptureStatus(role);
    } catch (error) {
      uploadDroppedCount[role] += 1;
      logLine(`${role} WS send failed for seq=${uploadSeq[role]}: ${error.message}`);
      break;
    }
  }
}

function handleAudioProcessForRole(event, role) {
  if (!audioContext) return;

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
  lastAudioProcessAtMs[role] = Date.now();
  queueUploadSamples(role, pcm16);
  processUploadQueue(role);
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
  ensureDualInputReady();
  audioChunks = [];
  mediaRecorder = makeMediaRecorder(mixRecordDestinationNode.stream);

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
  logLine(`Mixed recording started; mimeType=${mediaRecorder.mimeType || "default"}`);
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

function normalizeHttpBaseUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Gateway HTTP URL is empty");
  }
  const base = trimmed.replace(/\/+$/, "");
  if (!base.startsWith("http://") && !base.startsWith("https://")) {
    throw new Error("Gateway HTTP URL must start with http:// or https://");
  }
  return base;
}

function httpSessionUrl(pathSuffix) {
  return `${normalizeHttpBaseUrl(apiBaseUrlEl.value)}/v1/sessions/${encodeURIComponent(meetingIdValue())}/${pathSuffix}`;
}

function validateParticipantsInput() {
  const participants = parseParticipantsFromUI();
  for (const item of participants) {
    if (!item.name || item.name.length < 1) {
      throw new Error("Participant name is required");
    }
  }
  return participants;
}

async function apiRequest(pathSuffix, method = "GET", body = undefined) {
  const url = httpSessionUrl(pathSuffix);
  const response = await desktopAPI.apiRequest({
    method,
    url,
    headers: {
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = response.text || "";
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`API ${method} ${url} failed: ${response.status} ${JSON.stringify(payload).slice(0, 400)}`);
  }
  return payload;
}

function wsSessionUrl(role) {
  return `${normalizeWsBaseUrl(wsUrlEl.value)}/${encodeURIComponent(meetingIdValue())}/${role}`;
}

function closeUploadSocket(role, reason) {
  const ws = uploadSockets[role];
  if (!ws) return;

  uploadClosing[role] = true;
  uploadSocketReady[role] = false;
  logLine(`Closing ${role} WS: reason=${reason}`);
  updateButtons();

  try {
    if (ws.readyState === window.WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "close", stream_role: role, reason }));
    }
  } catch {
    // noop
  }

  try {
    ws.close(1000, reason.slice(0, 120));
  } catch {
    // noop
  }

  window.setTimeout(() => {
    if (uploadSockets[role] === ws) {
      uploadSockets[role] = undefined;
      uploadSocketReady[role] = false;
      uploadClosing[role] = false;
      resetUploadQueue(role);
      logLine(`${role} WS close timeout fallback: local upload stopped.`);
      if (!isAnyUploadActive()) {
        suppressAutoRecover = false;
        stopLivePolling();
        setUploadStatus("Upload stopped.");
      } else {
        renderUploadStatus();
      }
      updateButtons();
    }
  }, 1500);
}

function bindUploadSocketEvents(role, ws) {
  ws.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      logLine(`${role} WS message(text): ${event.data}`);
      return;
    }

    if (payload.type === "ready") {
      const serverLastSeq = Number(payload?.ingest?.last_seq ?? 0);
      if (Number.isFinite(serverLastSeq) && serverLastSeq > 0) {
        uploadSeq[role] = Math.max(uploadSeq[role], serverLastSeq);
      }
      uploadSocketReady[role] = true;
      logLine(`${role} WS ready: resume from seq=${uploadSeq[role] + 1}`);
      emitCaptureStatus(role);
      processUploadQueue(role);
      renderUploadStatus();
      return;
    }

    if (payload.type === "ack") {
      uploadAckCount[role] += 1;
      uploadMissingCount[role] = Number(payload.missing_count || uploadMissingCount[role]);
      renderUploadStatus();
      return;
    }

    if (payload.type === "status") {
      setResultPayload(payload);
      logLine(`${role} WS status: ${JSON.stringify(payload)}`);
      return;
    }

    if (payload.type === "capture_status_ack") {
      return;
    }

    if (payload.type === "error") {
      logLine(`${role} WS server error: ${payload.detail}`);
      setResultPayload(payload);
      return;
    }

    logLine(`${role} WS message: ${JSON.stringify(payload)}`);
  });

  ws.addEventListener("close", (event) => {
    if (uploadSockets[role] !== ws) return;

    const startedAt = uploadStartedAtMs[role] || Date.now();
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    logLine(`${role} WS closed code=${event.code} reason=${event.reason || "none"} elapsed=${elapsedSec}s`);

    uploadSockets[role] = undefined;
    uploadSocketReady[role] = false;
    uploadClosing[role] = false;
    resetUploadQueue(role);
    if (!isAnyUploadActive()) {
      suppressAutoRecover = false;
      stopLivePolling();
      setUploadStatus(
        `Upload closed: teacher sent=${uploadSentCount.teacher},ack=${uploadAckCount.teacher}; students sent=${uploadSentCount.students},ack=${uploadAckCount.students}`
      );
    } else {
      renderUploadStatus();
    }
    updateButtons();
  });

  ws.addEventListener("error", () => {
    logLine(`${role} WS error event received.`);
    setUploadStatus("Upload error. Check gateway URL and worker logs.");
  });
}

async function openUploadSocket(role) {
  const endpoint = wsSessionUrl(role);
  logLine(`Connecting ${role} WS: ${endpoint}`);
  const ws = new window.WebSocket(endpoint);
  uploadSockets[role] = ws;
  uploadClosing[role] = false;
  uploadStartedAtMs[role] = Date.now();
  uploadSocketReady[role] = false;

  bindUploadSocketEvents(role, ws);

  await new Promise((resolve, reject) => {
    let settled = false;
    const onOpen = () => {
      if (settled) return;
      try {
        const teamsParticipants = validateParticipantsInput();
        const names = effectiveInterviewerNames();
        settled = true;
        ws.removeEventListener("error", onError);
        ws.send(
          JSON.stringify({
            type: "hello",
            stream_role: role,
            meeting_id: meetingIdValue(),
            sample_rate: TARGET_SAMPLE_RATE,
            channels: TARGET_CHANNELS,
            format: TARGET_FORMAT,
            capture_mode: "dual_stream",
            interviewer_name: names.interviewerName,
            teams_interviewer_name: names.teamsInterviewerName,
            teams_participants: teamsParticipants
          })
        );
        resolve();
      } catch (error) {
        settled = true;
        ws.removeEventListener("error", onError);
        reject(error);
      }
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      ws.removeEventListener("open", onOpen);
      reject(new Error(`${role} websocket open failed`));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
}

async function startUpload() {
  ensureDualInputReady();
  if (isAnyUploadActive()) {
    throw new Error("upload already started");
  }
  suppressAutoRecover = false;
  recentStudentsChunks.length = 0;
  recentEchoSuppression.length = 0;
  captureMetrics.teacher.echo_suppressed_chunks = 0;
  captureMetrics.teacher.echo_suppression_recent_rate = 0;
  updateCaptureMetrics("teacher", {
    capture_state: "running",
    last_recover_error: null
  });
  updateCaptureMetrics("students", {
    capture_state: "running",
    last_recover_error: null
  });

  UPLOAD_STREAM_ROLES.forEach((role) => {
    uploadSeq[role] = 0;
    uploadAckCount[role] = 0;
    uploadMissingCount[role] = 0;
    uploadSentCount[role] = 0;
    uploadDroppedCount[role] = 0;
    uploadSocketReady[role] = false;
    uploadClosing[role] = false;
    uploadStartedAtMs[role] = Date.now();
    resetUploadQueue(role);
  });

  setUploadStatus("Connecting teacher/students WS...");
  updateButtons();

  try {
    await saveSessionConfig();
    await Promise.all([openUploadSocket("teacher"), openUploadSocket("students")]);
    setUploadStatus("Upload active (dual stream): waiting for chunk ACKs...");
    logLine("WS connected; dual-stream upload started.");
    await refreshLiveView().catch(() => {
      // ignore initial fetch failures, polling will retry
    });
    startLivePolling();
    updateButtons();
  } catch (error) {
    stopUpload("start-upload-failed");
    throw error;
  }
}

function stopUpload(reason = "client-stop") {
  if (!isAnyUploadActive()) return;
  suppressAutoRecover = true;
  if (studentsRecoveryTimer) {
    window.clearTimeout(studentsRecoveryTimer);
    studentsRecoveryTimer = undefined;
  }
  logLine(`Stop Upload clicked. reason=${reason}`);
  UPLOAD_STREAM_ROLES.forEach((role) => closeUploadSocket(role, reason));
  updateCaptureMetrics("teacher", { capture_state: micStream ? "running" : "idle" });
  updateCaptureMetrics("students", { capture_state: systemAudioStream ? "running" : "idle" });
}

function fetchUploadStatus() {
  const readyRoles = UPLOAD_STREAM_ROLES.filter((role) => {
    const ws = uploadSockets[role];
    return Boolean(ws && uploadSocketReady[role] && ws.readyState === window.WebSocket.OPEN);
  });
  if (readyRoles.length === 0) {
    throw new Error("upload sockets are not ready");
  }

  readyRoles.forEach((role) => {
    uploadSockets[role].send(JSON.stringify({ type: "status", stream_role: role }));
  });
}

function formatUtteranceLines(title, response) {
  const header = `${title} (count=${response.count})`;
  const lines = (response.items || []).slice(-8).map((item) => {
    const seq = `${item.start_seq}-${item.end_seq}`;
    const latency = Number.isFinite(item.latency_ms) ? `${item.latency_ms}ms` : "-";
    const sources = Array.isArray(item.source_utterance_ids) ? ` src=${item.source_utterance_ids.length}` : "";
    return `[${seq}] (${latency})${sources} ${item.text}`;
  });
  return [header, ...lines].join("\n");
}

function formatEvents(response) {
  const header = `events count=${response.count}`;
  const lines = (response.items || []).slice(-20).map((item) => {
    const source = item.identity_source ? `/${item.identity_source}` : "";
    const name = item.speaker_name || (item.cluster_id ? `cluster:${item.cluster_id}` : "unknown");
    const decision = item.decision || "n/a";
    return `${item.ts} [${item.stream_role}] ${item.source}${source} -> ${name} (${decision})`;
  });
  return [header, ...lines].join("\n");
}

async function saveSessionConfig() {
  const names = effectiveInterviewerNames();
  const body = {
    teams_participants: validateParticipantsInput(),
    teams_interviewer_name: names.teamsInterviewerName,
    interviewer_name: names.interviewerName
  };
  const payload = await apiRequest("config", "POST", body);
  setResultPayload(payload);
  logLine(`Session config saved. roster_count=${payload.roster_count || 0}`);
}

async function refreshLiveView() {
  const [state, teacherRaw, teacherMerged, studentsRaw, studentsMerged, events] = await Promise.all([
    apiRequest("state", "GET"),
    apiRequest("utterances?stream_role=teacher&view=raw&limit=50", "GET"),
    apiRequest("utterances?stream_role=teacher&view=merged&limit=50", "GET"),
    apiRequest("utterances?stream_role=students&view=raw&limit=50", "GET"),
    apiRequest("utterances?stream_role=students&view=merged&limit=50", "GET"),
    apiRequest("events?limit=100", "GET")
  ]);

  liveTranscriptEl.textContent = [
    formatUtteranceLines("Teacher Raw", teacherRaw),
    "",
    formatUtteranceLines("Teacher Merged", teacherMerged),
    "",
    formatUtteranceLines("Students Raw", studentsRaw),
    "",
    formatUtteranceLines("Students Merged", studentsMerged),
    "",
    `Capture Teacher: ${JSON.stringify(state.capture_by_stream?.teacher || {})}`,
    `Capture Students: ${JSON.stringify(state.capture_by_stream?.students || {})}`,
    "",
    `ASR Teacher: ${JSON.stringify(state.asr_by_stream?.teacher || {})}`,
    `ASR Students: ${JSON.stringify(state.asr_by_stream?.students || {})}`
  ].join("\n");
  speakerEventsEl.textContent = formatEvents(events);
  setResultPayload(state);
}

function startLivePolling() {
  if (livePollTimer) {
    window.clearInterval(livePollTimer);
    livePollTimer = undefined;
  }
  livePollTimer = window.setInterval(() => {
    refreshLiveView().catch((error) => {
      logLine(`Live refresh failed: ${error.message}`);
    });
  }, 2000);
}

function stopLivePolling() {
  if (!livePollTimer) return;
  window.clearInterval(livePollTimer);
  livePollTimer = undefined;
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
  btnInitMic.addEventListener("click", async () => {
    try {
      await initMicStream();
      updateButtons();
      logLine("Mic stream initialized.");
    } catch (error) {
      logLine(`Mic init failed: ${error.message}`);
      setResultPayload({ error: error.message });
      updateButtons();
    }
  });

  btnInitSystem.addEventListener("click", async () => {
    try {
      await initSystemStream({ manual: true, reason: "manual-init" });
      updateButtons();
      logLine("System audio stream initialized.");
    } catch (error) {
      const detail = `${error?.name || "Error"}: ${error?.message || "unknown"}`;
      logLine(`System audio init failed: ${detail}`);
      setResultPayload({ error: detail });
      updateButtons();
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
      stopUpload("start-upload-failed");
      updateButtons();
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

  btnSaveSessionConfig.addEventListener("click", async () => {
    try {
      await saveSessionConfig();
      await refreshLiveView();
    } catch (error) {
      logLine(`Save session config failed: ${error.message}`);
      setResultPayload({ error: error.message });
    }
  });

  btnRefreshLive.addEventListener("click", async () => {
    try {
      await refreshLiveView();
      logLine("Live view refreshed.");
    } catch (error) {
      logLine(`Refresh live view failed: ${error.message}`);
      setResultPayload({ error: error.message });
    }
  });

  if (btnParticipantAdd) {
    btnParticipantAdd.addEventListener("click", () => {
      addParticipantRow();
    });
  }

  if (btnParticipantImport) {
    btnParticipantImport.addEventListener("click", () => {
      const pasted = window.prompt("Paste participant names (one per line):", "");
      if (pasted === null) return;
      const count = importParticipantsFromLines(pasted);
      logLine(`Imported participants: ${count}`);
    });
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  if (participantRows().length === 0) {
    addParticipantRow();
  }
  renderCaptureHealth();
  updateButtons();
  await renderRuntimeInfo();
  bindEvents();
  await refreshLiveView().catch(() => {
    // ignore startup fetch failures
  });
});

window.addEventListener("beforeunload", () => {
  suppressAutoRecover = true;
  clearRecordingTimer();

  if (meterFrameId) {
    window.cancelAnimationFrame(meterFrameId);
  }

  if (isAnyUploadActive()) {
    stopUpload("window-close");
  }
  if (studentsRecoveryTimer) {
    window.clearTimeout(studentsRecoveryTimer);
    studentsRecoveryTimer = undefined;
  }
  stopLivePolling();

  releaseMicStream();
  releaseSystemStream();

  if (audioContext) {
    audioContext.close();
  }

  if (playbackBlobUrl) {
    URL.revokeObjectURL(playbackBlobUrl);
  }
});
