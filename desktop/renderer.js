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
const ECHO_CALIBRATION_MS = 20_000;
const ECHO_HOLD_MS = 2200;
const ECHO_HOLD_DECAY_MS = 1200;
const ECHO_DOUBLE_TALK_MIN_RMS = 0.015;
const ECHO_DOUBLE_TALK_RATIO_LOW = 0.72;
const ECHO_DOUBLE_TALK_RATIO_HIGH = 1.45;
const ECHO_DYNAMIC_CORR_FLOOR = 0.68;
const ECHO_DYNAMIC_CORR_CEIL = 0.92;
const ECHO_DYNAMIC_RATIO_FLOOR = 1.1;
const ECHO_DYNAMIC_RATIO_CEIL = 1.9;
const BACKEND_FAILOVER_TRIGGER_STREAK = 3;
const BACKEND_RECOVERY_TRIGGER_STREAK = 4;
const BACKEND_SWITCH_COOLDOWN_MS = 12_000;
const BACKEND_HEALTH_STALE_MS = 25_000;
const SIDECAR_HEALTH_REFRESH_MS = 6000;
const UPLOAD_STREAM_ROLES = ["teacher", "students"];

const appInfoEl = document.querySelector("#app-info");
const meetingIdEl = document.querySelector("#meeting-id");
const apiBaseUrlEl = document.querySelector("#api-base-url");
const wsUrlEl = document.querySelector("#ws-url");
const uploadStatusEl = document.querySelector("#upload-status");
const dashboardUploadStatusEl = document.querySelector("#dashboard-upload-status");
const resultJsonEl = document.querySelector("#result-json");
const liveTranscriptEl = document.querySelector("#live-transcript");
const speakerEventsEl = document.querySelector("#speaker-events");
const logsEl = document.querySelector("#logs");
const playbackEl = document.querySelector("#playback");
const selectedFileEl = document.querySelector("#selected-file");
const interviewerNameEl = document.querySelector("#interviewer-name");
const captureHealthEl = document.querySelector("#capture-health");
const enrollmentStatusEl = document.querySelector("#enrollment-status");
const clusterMapListEl = document.querySelector("#cluster-map-list");
const participantListEl = document.querySelector("#participant-list");
const btnParticipantAdd = document.querySelector("#btn-participant-add");
const btnParticipantImport = document.querySelector("#btn-participant-import");
const teamsInterviewerNameEl = document.querySelector("#teams-interviewer-name");
const diarizationBackendEl = document.querySelector("#diarization-backend");
const micAecEl = document.querySelector("#mic-aec");
const micNsEl = document.querySelector("#mic-ns");
const micAgcEl = document.querySelector("#mic-agc");
const sidecarStatusEl = document.querySelector("#sidecar-status");
const btnSidecarStart = document.querySelector("#btn-sidecar-start");
const btnSidecarStop = document.querySelector("#btn-sidecar-stop");

const memoTypeEl = document.querySelector("#memo-type");
const memoTagsEl = document.querySelector("#memo-tags");
const memoTextEl = document.querySelector("#memo-text");
const memoListEl = document.querySelector("#memo-list");
const btnMemoAdd = document.querySelector("#btn-memo-add");
const btnMemoAnchorLast = document.querySelector("#btn-memo-anchor-last");

const btnFinalizeV2 = document.querySelector("#btn-finalize-v2");
const finalizeV2StatusEl = document.querySelector("#finalize-v2-status");
const reportV2El = document.querySelector("#report-v2");

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
const btnEnrollmentStart = document.querySelector("#btn-enrollment-start");
const btnEnrollmentStop = document.querySelector("#btn-enrollment-stop");
const btnRefreshLive = document.querySelector("#btn-refresh-live");
const btnRefreshClusters = document.querySelector("#btn-refresh-clusters");
const btnAttachTeams = document.querySelector("#btn-attach-teams");
const btnDetachTeams = document.querySelector("#btn-detach-teams");
const attachStatusEl = document.querySelector("#attach-status");
const backendBadgeEls = [
  document.querySelector("#backend-badge"),
  document.querySelector("#backend-badge-dashboard")
].filter(Boolean);
const recordingTimerEl = document.querySelector("#recording-timer");
const dashboardRecordingTimerEl = document.querySelector("#dashboard-recording-timer");
const btnToggleDebug = document.querySelector("#btn-toggle-debug");
const debugDrawerEl = document.querySelector("#debug-drawer");
const debugTabButtons = Array.from(document.querySelectorAll("[data-debug-tab-btn]"));
const btnOpenReview = document.querySelector("#btn-open-review");
const btnOpenFeedback = document.querySelector("#btn-open-feedback");
const btnFeedbackReady = document.querySelector("#btn-feedback-ready");
const btnFeedbackExportText = document.querySelector("#btn-feedback-export-text");
const btnFeedbackExportMd = document.querySelector("#btn-feedback-export-md");
const btnFeedbackExportDocx = document.querySelector("#btn-feedback-export-docx");
const reviewPanelEl = document.querySelector("#review-panel");
const reviewTabOverallBtn = document.querySelector("#btn-review-tab-overall");
const reviewTabPersonBtn = document.querySelector("#btn-review-tab-person");
const reviewTabEvidenceBtn = document.querySelector("#btn-review-tab-evidence");
const reviewOverallEl = document.querySelector("#review-overall");
const reviewPerPersonEl = document.querySelector("#review-per-person");
const reviewEvidenceEl = document.querySelector("#review-evidence");
const participantLiveListEl = document.querySelector("#participant-live-list");
const finalizeStageListEl = document.querySelector("#finalize-stage-list");
const finalizeStageItems = finalizeStageListEl
  ? Array.from(finalizeStageListEl.querySelectorAll("[data-finalize-stage]"))
  : [];
const appRootEl = document.querySelector("#app-root");
const dashboardViewEl = document.querySelector("#dashboard-view");
const sessionViewEl = document.querySelector("#session-view");
const btnBackDashboard = document.querySelector("#btn-back-dashboard");
const btnDashboardEnterSession = document.querySelector("#btn-dashboard-enter-session");
const dashboardMeetingTitleEl = document.querySelector("#dashboard-meeting-title");
const dashboardMeetingStartEl = document.querySelector("#dashboard-meeting-start");
const dashboardMeetingUrlEl = document.querySelector("#dashboard-meeting-url");
const dashboardMeetingParticipantsEl = document.querySelector("#dashboard-meeting-participants");
const btnDashboardAddMeeting = document.querySelector("#btn-dashboard-add-meeting");
const dashboardMeetingListEl = document.querySelector("#dashboard-meeting-list");
const btnHistoryRefresh = document.querySelector("#btn-history-refresh");
const historyListEl = document.querySelector("#history-list");
const graphClientIdEl = document.querySelector("#graph-client-id");
const graphTenantIdEl = document.querySelector("#graph-tenant-id");
const btnGraphSaveConfig = document.querySelector("#btn-graph-save-config");
const btnGraphConnect = document.querySelector("#btn-graph-connect");
const btnGraphSync = document.querySelector("#btn-graph-sync");
const btnGraphDisconnect = document.querySelector("#btn-graph-disconnect");
const graphStatusEl = document.querySelector("#graph-status");
const btnOpenAccessibilitySettings = document.querySelector("#btn-open-accessibility-settings");
const btnOpenAutomationSettings = document.querySelector("#btn-open-automation-settings");
const btnGraphCreateMeeting = document.querySelector("#btn-graph-create-meeting");
const attachHintEl = document.querySelector("#attach-hint");
const btnUiDensity = document.querySelector("#btn-ui-density");
const flowStageLabelEl = document.querySelector("#flow-stage-label");
const flowSessionTimerEl = document.querySelector("#flow-session-timer");
const flowFeedbackSlaEl = document.querySelector("#flow-feedback-sla");
const evidenceModalEl = document.querySelector("#evidence-modal");
const evidenceModalContentEl = document.querySelector("#evidence-modal-content");
const evidenceModalCloseEl = document.querySelector("#evidence-modal-close");
const btnEvidenceModalClose = document.querySelector("#btn-evidence-modal-close");
const btnRegenerateClaim = document.querySelector("#btn-regenerate-claim");
const btnApplyClaimEvidence = document.querySelector("#btn-apply-claim-evidence");
const claimEvidenceRefsEl = document.querySelector("#claim-evidence-refs");

const transcriptFormatter = window.IFTranscriptFormatter || {};
const liveMetricsEngine = window.IFLiveMetrics || {};

function safeLogToConsole(message) {
  try {
    // Keep a stable diagnostics channel even when renderer UI is not ready.
    console.error(`[desktop-renderer] ${message}`);
  } catch {
    // noop
  }
}

window.addEventListener("error", (event) => {
  safeLogToConsole(`window error: ${event.message} @ ${event.filename || "unknown"}:${event.lineno || 0}`);
});

window.addEventListener("unhandledrejection", (event) => {
  safeLogToConsole(`unhandled rejection: ${String(event.reason)}`);
});

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
let pendingMemoAnchor = null;
let finalizeV2PollTimer;
let finalizeV2JobId = "";
let sidecarActive = false;
let attachPollTimer;
let sessionTimer;
let sessionStartedAtMs = 0;
let attachStatus = { status: "searching", reason: "initializing" };
let currentReviewTab = "overall";
let latestLiveSnapshot = null;
let latestFeedbackReport = null;
let selectedClaimContext = null;
let historyCursor = null;
let historyItemsCache = [];
const logBuffer = [];
let appMode = "dashboard";
let dashboardMeetings = [];
let uiDensity = "comfort";
let deepLinkUnsubscribe = null;
let sessionConfigOverrides = {
  mode: "",
  template_id: "",
  booking_ref: "",
  teams_join_url: ""
};
const backendSwitchState = {
  autoEnabled: true,
  preferredBackend: "cloud",
  activeBackend: "cloud",
  cloudFailureStreak: 0,
  cloudRecoveryStreak: 0,
  edgeFailureStreak: 0,
  edgeRecoveryStreak: 0,
  lastSwitchAtMs: 0,
  lastReason: "",
  speechBackendMode: "cloud-primary",
  dependencyHealth: null,
  lastHealthAtMs: 0,
  autoSwitchInFlight: false
};
const echoCalibrationState = {
  active: false,
  startedAtMs: 0,
  corrSamples: [],
  ratioSamples: [],
  softCorr: ECHO_CORR_THRESHOLD,
  strongCorr: ECHO_STRONG_CORR_THRESHOLD,
  teacherRatio: ECHO_TEACHER_STUDENT_RMS_RATIO,
  calibrated: false,
  holdUntilMs: 0
};
let lastSidecarHealthRefreshMs = 0;

const FINALIZE_STAGE_ORDER = [
  "queued",
  "freeze",
  "drain",
  "replay_gap",
  "aggregate",
  "analysis_events",
  "analysis_report",
  "persist"
];

function logLine(message) {
  const stamp = new Date().toISOString();
  const line = `[${stamp}] ${message}`;
  logBuffer.unshift(line);
  if (logBuffer.length > 500) {
    logBuffer.length = 500;
  }
  if (!logsEl) {
    safeLogToConsole(line);
    return;
  }
  logsEl.textContent = logBuffer.join("\n");
}

function meetingIdValue() {
  return meetingIdEl.value.trim() || "local-selfcheck";
}

function setResultPayload(payload) {
  if (!resultJsonEl) return;
  resultJsonEl.textContent = JSON.stringify(payload, null, 2);
}

function setUploadStatus(message) {
  if (uploadStatusEl) {
    uploadStatusEl.textContent = message;
  }
  if (dashboardUploadStatusEl) {
    dashboardUploadStatusEl.textContent = message;
  }
}

function setDisabled(el, disabled) {
  if (!el) return;
  el.disabled = Boolean(disabled);
}

function toClock(ms) {
  const safeMs = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizeAttachStatus(input) {
  const status = String(input?.status || "error");
  const reason = input?.reason ? String(input.reason) : "";
  return {
    status,
    reason,
    teams_bounds: input?.teams_bounds || null,
    overlay_bounds: input?.overlay_bounds || null
  };
}

function humanizeAttachReason(reason) {
  const text = String(reason || "").trim();
  if (!text) return "";
  if (text.includes("不允许辅助访问")) {
    return "Accessibility permission is missing for this runtime (Electron/Terminal).";
  }
  return text;
}

function renderAttachStatus(input) {
  attachStatus = normalizeAttachStatus(input);
  if (!attachStatusEl) return;
  const status = attachStatus.status;
  const reason = humanizeAttachReason(attachStatus.reason);
  attachStatusEl.title = reason || "";
  attachStatusEl.classList.remove("chip-info", "chip-accent", "chip-neutral");
  if (status === "attached") {
    attachStatusEl.classList.add("chip-accent");
    attachStatusEl.textContent = "Attach: attached";
    if (attachHintEl) {
      attachHintEl.textContent = "Attached to Teams. Sidebar follows the meeting window.";
    }
  } else if (status === "searching") {
    attachStatusEl.classList.add("chip-neutral");
    attachStatusEl.textContent = "Attach: searching";
    if (attachHintEl) {
      attachHintEl.textContent = "Searching for Teams window...";
    }
  } else if (status === "teams_not_found") {
    attachStatusEl.classList.add("chip-neutral");
    attachStatusEl.textContent = "Attach: teams_not_found";
    if (attachHintEl) {
      attachHintEl.textContent = "Open a Teams meeting window first, then click Attach.";
    }
  } else if (status === "permission_required") {
    attachStatusEl.classList.add("chip-info");
    attachStatusEl.textContent = "Attach: permission_required";
    if (attachHintEl) {
      attachHintEl.textContent =
        `Permission required. ${reason || "Grant Accessibility/Automation access."} After granting, restart the app once.`;
    }
  } else {
    attachStatusEl.classList.add("chip-info");
    attachStatusEl.textContent = `Attach: ${status}`;
    if (attachHintEl) {
      attachHintEl.textContent = reason || "Attach error. Check debug logs.";
    }
  }
}

function ensureSessionTimer() {
  if (sessionTimer) return;
  sessionTimer = window.setInterval(() => {
    if (!recordingTimerEl && !flowSessionTimerEl && !dashboardRecordingTimerEl) return;
    if (!sessionStartedAtMs || !isAnyUploadActive()) {
      if (recordingTimerEl) recordingTimerEl.textContent = "00:00";
      if (flowSessionTimerEl) flowSessionTimerEl.textContent = "00:00";
      if (dashboardRecordingTimerEl) dashboardRecordingTimerEl.textContent = "00:00";
      return;
    }
    const clock = toClock(Date.now() - sessionStartedAtMs);
    if (recordingTimerEl) recordingTimerEl.textContent = clock;
    if (flowSessionTimerEl) flowSessionTimerEl.textContent = clock;
    if (dashboardRecordingTimerEl) dashboardRecordingTimerEl.textContent = clock;
  }, 1000);
}

function stopSessionTimer() {
  if (sessionTimer) {
    window.clearInterval(sessionTimer);
    sessionTimer = undefined;
  }
  if (recordingTimerEl && !isAnyUploadActive()) {
    recordingTimerEl.textContent = "00:00";
  }
  if (flowSessionTimerEl && !isAnyUploadActive()) {
    flowSessionTimerEl.textContent = "00:00";
  }
  if (dashboardRecordingTimerEl && !isAnyUploadActive()) {
    dashboardRecordingTimerEl.textContent = "00:00";
  }
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
  const attachReady = attachStatus.status === "attached";

  setDisabled(btnInitMic, hasMic);
  setDisabled(btnInitSystem, hasSystem);
  setDisabled(btnStartRecording, !dualReady || recording);
  setDisabled(btnStopRecording, !recording);
  setDisabled(btnStartUpload, !dualReady || uploadActive || !attachReady);
  setDisabled(btnStopUpload, !uploadActive);
  setDisabled(btnFetchUploadStatus, !uploadActive);
  setDisabled(btnOpenLastFile, !lastOutputPath);
  setDisabled(btnNormalizeFile, !selectedInputFilePath);
  setDisabled(btnDetachTeams, attachStatus.status !== "attached");

  if (!dualReady && !uploadActive) {
    setUploadStatus("Upload not started. Dual input required (mic + system).");
  } else if (!attachReady && !uploadActive) {
    setUploadStatus("Upload blocked until Teams window is attached.");
  }
  updateBackendBadge();
  ensureSessionTimer();
}

function readJsonStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // noop
  }
}

function normalizedUiDensity(input) {
  return String(input || "").trim().toLowerCase() === "compact" ? "compact" : "comfort";
}

function applyUiDensity(density) {
  uiDensity = normalizedUiDensity(density);
  if (appRootEl) {
    appRootEl.setAttribute("data-density", uiDensity);
  }
  if (btnUiDensity) {
    btnUiDensity.textContent = `Density: ${uiDensity === "compact" ? "Compact" : "Comfort"}`;
  }
  writeJsonStorage("if.desktop.ui_density", uiDensity);
}

function toggleUiDensity() {
  applyUiDensity(uiDensity === "compact" ? "comfort" : "compact");
}

function setAppMode(mode) {
  const normalized = mode === "session" ? "session" : "dashboard";
  appMode = normalized;
  if (appRootEl) {
    appRootEl.classList.toggle("mode-dashboard", normalized === "dashboard");
    appRootEl.classList.toggle("mode-session", normalized === "session");
  }
  if (dashboardViewEl) {
    dashboardViewEl.classList.toggle("hidden", normalized !== "dashboard");
  }
  if (sessionViewEl) {
    sessionViewEl.classList.toggle("hidden", normalized !== "session");
  }
  if (normalized === "dashboard" && reviewPanelEl) {
    reviewPanelEl.classList.add("hidden");
  }
  desktopAPI.setWindowMode({ mode: normalized }).catch((error) => {
    logLine(`setWindowMode failed: ${error.message}`);
  });
}

function parseParticipantLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function setParticipantsInUI(names) {
  if (!participantListEl) return;
  participantListEl.innerHTML = "";
  const unique = [];
  const seen = new Set();
  for (const name of names) {
    const normalized = String(name || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  if (!unique.length) {
    addParticipantRow();
    return;
  }
  for (const name of unique) {
    addParticipantRow({ name });
  }
}

function updateSessionConfigOverrides(patch = {}) {
  const mode = String(patch.mode || "").trim();
  const templateId = String(patch.template_id || "").trim();
  const bookingRef = String(patch.booking_ref || "").trim();
  const teamsJoinUrl = String(patch.teams_join_url || "").trim();
  if (mode === "1v1" || mode === "group") {
    sessionConfigOverrides.mode = mode;
  }
  if (templateId) {
    sessionConfigOverrides.template_id = templateId;
  }
  if (bookingRef) {
    sessionConfigOverrides.booking_ref = bookingRef;
  }
  if (teamsJoinUrl) {
    sessionConfigOverrides.teams_join_url = teamsJoinUrl;
  }
}

function sanitizeMeetingId(input) {
  const text = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (text) return text;
  return `meeting-${Date.now()}`;
}

function mergeMeetingsById(items) {
  const byId = new Map();
  for (const item of items) {
    const key = String(item?.meeting_id || "").trim();
    if (!key) continue;
    byId.set(key, item);
  }
  return Array.from(byId.values()).sort((a, b) => {
    const aStart = Date.parse(String(a?.start_at || "")) || 0;
    const bStart = Date.parse(String(b?.start_at || "")) || 0;
    return aStart - bStart;
  });
}

function persistDashboardMeetings() {
  writeJsonStorage("if.desktop.dashboard.meetings", dashboardMeetings);
}

function loadDashboardState() {
  dashboardMeetings = mergeMeetingsById(readJsonStorage("if.desktop.dashboard.meetings", []));
  uiDensity = normalizedUiDensity(readJsonStorage("if.desktop.ui_density", "comfort"));
  const graphConfig = readJsonStorage("if.desktop.graph.config", null);
  if (graphConfig?.clientId && graphClientIdEl) {
    graphClientIdEl.value = graphConfig.clientId;
  }
  if (graphConfig?.tenantId && graphTenantIdEl) {
    graphTenantIdEl.value = graphConfig.tenantId;
  }
}

function renderMeetingList() {
  if (!dashboardMeetingListEl) return;
  if (!dashboardMeetings.length) {
    dashboardMeetingListEl.innerHTML = `<p class="muted">No meetings yet. Add one manually or sync from Graph.</p>`;
    return;
  }
  const html = dashboardMeetings
    .map((meeting) => {
      const start = meeting?.start_at ? new Date(meeting.start_at).toLocaleString() : "unscheduled";
      const participants = Array.isArray(meeting?.participants) ? meeting.participants : [];
      const names = participants
        .map((entry) => (typeof entry === "string" ? entry : entry?.name))
        .map((name) => String(name || "").trim())
        .filter(Boolean)
        .slice(0, 8)
        .join(", ");
      return `
        <article class="meeting-item">
          <div class="meeting-item-head">
            <strong>${escapeHtml(meeting?.title || "Untitled Meeting")}</strong>
            <span class="muted small">${escapeHtml(meeting?.source || "manual")}</span>
          </div>
          <div class="muted small">start=${escapeHtml(start)}</div>
          <div class="muted small">participants=${escapeHtml(names || "-")}</div>
          <div class="actions wrap">
            <button type="button" data-meeting-action="start" data-meeting-id="${escapeHtml(meeting.meeting_id)}">Start Sidebar</button>
            <button type="button" data-meeting-action="remove" data-meeting-id="${escapeHtml(meeting.meeting_id)}">Remove</button>
          </div>
        </article>
      `;
    })
    .join("");
  dashboardMeetingListEl.innerHTML = html;
}

function renderHistoryList(items = [], hasMore = false, cursor = null) {
  if (!historyListEl) return;
  historyCursor = cursor || null;
  if (!Array.isArray(items) || items.length === 0) {
    historyListEl.innerHTML = `<p class="muted">No history records found.</p>`;
    return;
  }
  const normalizedItems = [...items].sort((left, right) => {
    const leftTs = Date.parse(String(left?.finalized_at || ""));
    const rightTs = Date.parse(String(right?.finalized_at || ""));
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
      return rightTs - leftTs;
    }
    return String(left?.session_id || "").localeCompare(String(right?.session_id || ""));
  });
  const html = normalizedItems
    .map((item) => {
      const sessionId = String(item?.session_id || "").trim();
      const finalizedAt = String(item?.finalized_at || "").trim();
      const source = String(item?.report_source || "memo_first");
      const ready = Boolean(item?.ready);
      const unresolved = Number(item?.unresolved_cluster_count || 0);
      const needsEvidence = Number(item?.needs_evidence_count || 0);
      const tentative = Boolean(item?.tentative);
      const finalizedText = finalizedAt ? new Date(finalizedAt).toLocaleString() : "-";
      return `
        <article class="meeting-item">
          <div class="meeting-item-head">
            <strong>${escapeHtml(sessionId || "unknown-session")}</strong>
            <span class="muted small">${escapeHtml(source)}</span>
          </div>
          <div class="muted small">finalized=${escapeHtml(finalizedText)}</div>
          <div class="muted small">ready=${escapeHtml(String(ready))}, tentative=${escapeHtml(String(tentative))}, unresolved=${escapeHtml(String(unresolved))}, needs_evidence=${escapeHtml(String(needsEvidence))}</div>
          <div class="actions wrap">
            <button type="button" data-history-action="open" data-session-id="${escapeHtml(sessionId)}">Open Report</button>
            <button type="button" data-history-action="copy-session" data-session-id="${escapeHtml(sessionId)}">Use Session ID</button>
          </div>
        </article>
      `;
    })
    .join("");
  historyListEl.innerHTML = `${html}${hasMore ? `<div class="actions wrap"><button type="button" data-history-action="more">Load More</button></div>` : ""}`;
}

async function refreshSessionHistory(options = {}) {
  const payload = await desktopAPI.listSessionHistory({
    baseUrl: normalizeHttpBaseUrl(apiBaseUrlEl.value),
    limit: options.limit || 20,
    cursor: options.cursor || ""
  });
  const incoming = Array.isArray(payload?.items) ? payload.items : [];
  if (options.append) {
    const byId = new Map(
      historyItemsCache.map((item) => [
        `${String(item?.session_id || "")}:${String(item?.finalized_at || "")}`,
        item
      ])
    );
    for (const item of incoming) {
      const key = `${String(item?.session_id || "")}:${String(item?.finalized_at || "")}`;
      if (!key) continue;
      byId.set(key, item);
    }
    historyItemsCache = Array.from(byId.values());
  } else {
    historyItemsCache = incoming;
  }
  renderHistoryList(historyItemsCache, Boolean(payload?.has_more), payload?.cursor || null);
  setResultPayload(payload);
  return payload;
}

function applyMeetingToSession(meeting) {
  if (!meeting) return;
  const idFromTitle = sanitizeMeetingId(meeting?.title);
  const meetingId = sanitizeMeetingId(meeting?.meeting_id || idFromTitle);
  if (meetingIdEl) {
    meetingIdEl.value = meetingId;
  }
  updateSessionConfigOverrides({
    teams_join_url: String(meeting?.join_url || "").trim()
  });
  const participants = Array.isArray(meeting?.participants) ? meeting.participants : [];
  const names = participants
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .filter(Boolean);
  setParticipantsInUI(names);
  saveSessionConfig().catch((error) => {
    logLine(`Save session config from dashboard failed: ${error.message}`);
  });
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
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

function clampNumber(value, minValue, maxValue) {
  const valueNumber = Number.isFinite(value) ? Number(value) : minValue;
  return Math.max(minValue, Math.min(maxValue, valueNumber));
}

function percentileValue(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values
    .filter((item) => Number.isFinite(item))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const normalized = clampNumber(percentile, 0, 100) / 100;
  const rank = normalized * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function normalizeBackend(input) {
  return String(input || "").trim().toLowerCase() === "edge" ? "edge" : "cloud";
}

function initBackendSwitchState() {
  backendSwitchState.autoEnabled = readJsonStorage("if.desktop.auto_backend_switch_enabled", true) !== false;
  writeJsonStorage("if.desktop.auto_backend_switch_enabled", backendSwitchState.autoEnabled);
  const selectedBackend = normalizeBackend(diarizationBackendEl?.value || "cloud");
  backendSwitchState.preferredBackend = selectedBackend;
  if (!backendSwitchState.activeBackend) {
    backendSwitchState.activeBackend = selectedBackend;
  }
}

function cloudHealthSignal(healthSnapshot) {
  if (!healthSnapshot || typeof healthSnapshot !== "object") {
    return { degraded: false, reason: "dependency health unavailable" };
  }
  const updatedAtMs = Date.parse(String(healthSnapshot.updated_at || ""));
  if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs > BACKEND_HEALTH_STALE_MS) {
    return {
      degraded: true,
      reason: `dependency health stale ${Math.round((Date.now() - updatedAtMs) / 1000)}s`
    };
  }
  const primaryEndpoints = healthSnapshot?.primary?.endpoints || {};
  const hotEndpoints = ["resolve", "analysis_events", "analysis_report"];
  const degradedEndpoints = [];
  for (const endpoint of hotEndpoints) {
    const status = String(primaryEndpoints?.[endpoint]?.status || "");
    if (status === "degraded" || status === "open_circuit") {
      degradedEndpoints.push(`${endpoint}:${status}`);
    }
  }
  if (degradedEndpoints.length > 0) {
    return {
      degraded: true,
      reason: `primary degraded (${degradedEndpoints.join(",")})`
    };
  }
  if (String(healthSnapshot.active_backend || "primary") === "secondary") {
    return {
      degraded: true,
      reason: "primary unavailable, inference failover active"
    };
  }
  return { degraded: false, reason: "" };
}

async function ensureSidecarRunning(reason = "auto-switch") {
  await refreshSidecarStatus().catch(() => {
    // ignore status pull failures and continue to active start.
  });
  if (sidecarActive) {
    return true;
  }
  try {
    const started = await desktopAPI.diarizationStart({});
    if (sidecarStatusEl) {
      sidecarStatusEl.textContent = JSON.stringify(started, null, 2);
    }
  } catch (error) {
    sidecarActive = false;
    backendSwitchState.lastReason = `sidecar start failed: ${error.message}`;
    logLine(`Sidecar auto-start failed (${reason}): ${error.message}`);
    updateBackendBadge();
    return false;
  }
  await refreshSidecarStatus().catch(() => {
    // ignore one-time status pull failure after start.
  });
  if (sidecarActive) {
    logLine(`Sidecar ready (${reason}).`);
  }
  return sidecarActive;
}

async function switchDiarizationBackend(nextBackend, reason, options = {}) {
  const targetBackend = normalizeBackend(nextBackend);
  const currentBackend = effectiveDiarizationBackend();
  if (targetBackend === currentBackend) {
    return false;
  }
  const automatic = options.automatic !== false;
  const persist = options.persist !== false;
  const skipCooldown = Boolean(options.skipCooldown);
  if (automatic && !skipCooldown) {
    const switchedAgo = Date.now() - backendSwitchState.lastSwitchAtMs;
    if (switchedAgo < BACKEND_SWITCH_COOLDOWN_MS) {
      return false;
    }
  }
  if (targetBackend === "edge") {
    const ready = await ensureSidecarRunning(reason || "switch-to-edge");
    if (!ready) {
      return false;
    }
  }
  backendSwitchState.activeBackend = targetBackend;
  backendSwitchState.lastSwitchAtMs = Date.now();
  backendSwitchState.lastReason = String(reason || "backend switch");
  if (diarizationBackendEl) {
    diarizationBackendEl.value = targetBackend;
  }
  updateBackendBadge();
  updateButtons();
  logLine(`Diarization backend switched to ${targetBackend} (${automatic ? "auto" : "manual"}): ${backendSwitchState.lastReason}`);
  if (persist) {
    try {
      await saveSessionConfig();
    } catch (error) {
      logLine(`Persist backend switch failed: ${error.message}`);
    }
  }
  return true;
}

async function evaluateBackendHealthAndMaybeSwitch(statePayload) {
  backendSwitchState.dependencyHealth = statePayload?.dependency_health || null;
  backendSwitchState.speechBackendMode = String(statePayload?.speech_backend_mode || backendSwitchState.speechBackendMode || "");
  backendSwitchState.lastHealthAtMs = Date.now();
  const cloudSignal = cloudHealthSignal(backendSwitchState.dependencyHealth);
  if (cloudSignal.degraded) {
    backendSwitchState.cloudFailureStreak += 1;
    backendSwitchState.cloudRecoveryStreak = 0;
    backendSwitchState.lastReason = cloudSignal.reason;
  } else {
    backendSwitchState.cloudFailureStreak = 0;
    backendSwitchState.cloudRecoveryStreak += 1;
  }
  if (effectiveDiarizationBackend() === "edge") {
    if (sidecarActive) {
      backendSwitchState.edgeFailureStreak = 0;
      backendSwitchState.edgeRecoveryStreak += 1;
    } else {
      backendSwitchState.edgeFailureStreak += 1;
      backendSwitchState.edgeRecoveryStreak = 0;
    }
  } else {
    backendSwitchState.edgeFailureStreak = 0;
    backendSwitchState.edgeRecoveryStreak = 0;
  }
  updateBackendBadge();
  if (!backendSwitchState.autoEnabled || backendSwitchState.autoSwitchInFlight) {
    return;
  }
  const currentBackend = effectiveDiarizationBackend();
  backendSwitchState.autoSwitchInFlight = true;
  try {
    if (
      currentBackend === "cloud" &&
      backendSwitchState.cloudFailureStreak >= BACKEND_FAILOVER_TRIGGER_STREAK
    ) {
      await switchDiarizationBackend("edge", cloudSignal.reason || "cloud degraded", {
        automatic: true,
        persist: true
      });
      return;
    }
    if (
      currentBackend === "edge" &&
      (
        backendSwitchState.edgeFailureStreak >= BACKEND_FAILOVER_TRIGGER_STREAK ||
        (
          backendSwitchState.preferredBackend === "cloud" &&
          backendSwitchState.cloudRecoveryStreak >= BACKEND_RECOVERY_TRIGGER_STREAK
        )
      )
    ) {
      await switchDiarizationBackend(
        "cloud",
        backendSwitchState.edgeFailureStreak >= BACKEND_FAILOVER_TRIGGER_STREAK
          ? "edge degraded"
          : "cloud recovered",
        {
          automatic: true,
          persist: true
        }
      );
    }
  } finally {
    backendSwitchState.autoSwitchInFlight = false;
  }
}

function effectiveDiarizationBackend() {
  return normalizeBackend(backendSwitchState.activeBackend || diarizationBackendEl?.value || "cloud");
}

function updateBackendBadge() {
  if (!backendBadgeEls.length) return;
  const activeBackend = effectiveDiarizationBackend();
  const mode = backendSwitchState.speechBackendMode ? ` | ${backendSwitchState.speechBackendMode}` : "";
  const source = backendSwitchState.autoEnabled ? "auto" : "manual";
  const hasRecentFailure = backendSwitchState.cloudFailureStreak > 0 || backendSwitchState.edgeFailureStreak > 0;
  for (const badgeEl of backendBadgeEls) {
    badgeEl.classList.remove("chip-neutral", "chip-info", "chip-accent");
    if (activeBackend === "edge") {
      badgeEl.classList.add("chip-accent");
    } else if (hasRecentFailure) {
      badgeEl.classList.add("chip-info");
    } else {
      badgeEl.classList.add("chip-neutral");
    }
    badgeEl.textContent = `Backend: ${activeBackend} (${source})${mode}`;
    badgeEl.title = backendSwitchState.lastReason || "";
  }
}

function normalizeFinalizeStage(rawStage) {
  const stage = String(rawStage || "").toLowerCase();
  if (!stage) return "queued";
  if (FINALIZE_STAGE_ORDER.includes(stage)) return stage;
  if (stage.includes("freeze")) return "freeze";
  if (stage.includes("drain")) return "drain";
  if (stage.includes("replay")) return "replay_gap";
  if (stage.includes("event")) return "analysis_events";
  if (stage.includes("report")) return "analysis_report";
  if (stage.includes("persist") || stage.includes("write")) return "persist";
  if (stage.includes("aggregate") || stage.includes("stats") || stage.includes("evidence")) return "aggregate";
  return "queued";
}

function renderFinalizeTimeline(statusObj = {}) {
  if (!finalizeStageItems.length) return;
  const normalizedStage = normalizeFinalizeStage(statusObj.stage);
  const activeIndex = FINALIZE_STAGE_ORDER.indexOf(normalizedStage);
  const succeeded = statusObj.status === "succeeded";
  const failed = statusObj.status === "failed";

  for (const li of finalizeStageItems) {
    const stage = li.dataset.finalizeStage;
    const index = FINALIZE_STAGE_ORDER.indexOf(stage);
    li.classList.remove("active", "done");
    if (succeeded) {
      li.classList.add("done");
      continue;
    }
    if (index >= 0 && index < activeIndex) {
      li.classList.add("done");
      continue;
    }
    if (index === activeIndex) {
      li.classList.add("active");
      continue;
    }
    if (failed && index === activeIndex) {
      li.classList.add("active");
    }
  }
}

function setFinalizeStatus(input) {
  if (!finalizeV2StatusEl) return;
  if (typeof input === "string") {
    finalizeV2StatusEl.textContent = input;
    return;
  }
  const status = String(input?.status || "queued");
  const stage = normalizeFinalizeStage(input?.stage);
  const progress = Number.isFinite(input?.progress) ? Number(input.progress) : 0;
  const degraded = Boolean(input?.degraded);
  const backendUsed = String(input?.backend_used || "");
  const warningText = Array.isArray(input?.warnings) && input.warnings.length > 0 ? ` warnings=${JSON.stringify(input.warnings)}` : "";
  const errorText = Array.isArray(input?.errors) && input.errors.length > 0 ? ` errors=${JSON.stringify(input.errors)}` : "";
  const backendText = backendUsed ? ` backend=${backendUsed}` : "";
  finalizeV2StatusEl.textContent =
    `status=${status} stage=${stage} progress=${progress}% degraded=${degraded}${backendText}${warningText}${errorText}`;
  renderFinalizeTimeline({ status, stage, progress });
}

function renderMemoList(items) {
  if (!memoListEl) return;
  if (!Array.isArray(items) || items.length === 0) {
    memoListEl.textContent = "No memos yet.";
    return;
  }
  const lines = items.slice(-20).map((item) => {
    const tags = Array.isArray(item.tags) && item.tags.length > 0 ? ` tags=${item.tags.join(",")}` : "";
    return `[${item.memo_id}] t=${item.created_at_ms} type=${item.type}${tags}\\n${item.text}`;
  });
  memoListEl.textContent = lines.join("\\n\\n");
}

async function refreshMemos() {
  const payload = await apiRequest("memos?limit=200", "GET");
  renderMemoList(payload.items || []);
  return payload;
}

async function addMemo() {
  const text = String(memoTextEl?.value || "").trim();
  if (!text) {
    throw new Error("memo text is empty");
  }
  const tags = String(memoTagsEl?.value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const body = {
    type: String(memoTypeEl?.value || "observation"),
    tags,
    text,
    anchors: pendingMemoAnchor || undefined
  };
  const payload = await apiRequest("memos", "POST", body);
  pendingMemoAnchor = null;
  if (memoTextEl) memoTextEl.value = "";
  await refreshMemos();
  setResultPayload(payload);
  logLine(`Memo added: ${payload.memo?.memo_id || "unknown"}`);
}

async function anchorMemoToLastUtterance() {
  const students = await apiRequest("utterances?stream_role=students&view=raw&limit=1", "GET");
  const teacher = await apiRequest("utterances?stream_role=teacher&view=raw&limit=1", "GET");
  const a = Array.isArray(students.items) && students.items.length > 0 ? students.items[students.items.length - 1] : null;
  const b = Array.isArray(teacher.items) && teacher.items.length > 0 ? teacher.items[teacher.items.length - 1] : null;
  const picked = !a ? b : !b ? a : (a.end_ms >= b.end_ms ? a : b);
  if (!picked) {
    throw new Error("no utterance available for anchor");
  }
  pendingMemoAnchor = {
    mode: "utterance",
    utterance_ids: [picked.utterance_id]
  };
  logLine(`Memo anchor set to utterance ${picked.utterance_id}`);
}

function openEvidenceModal(payload) {
  selectedClaimContext = payload?.claim || null;
  if (btnRegenerateClaim) {
    btnRegenerateClaim.disabled = !selectedClaimContext;
  }
  if (btnApplyClaimEvidence) {
    btnApplyClaimEvidence.disabled = !selectedClaimContext;
  }
  if (claimEvidenceRefsEl) {
    const refs = Array.isArray(payload?.claim?.evidence_refs) ? payload.claim.evidence_refs : [];
    claimEvidenceRefsEl.value = refs.join(",");
  }
  if (evidenceModalContentEl) {
    const lines = [];
    const evidence = payload?.evidence || null;
    const claim = payload?.claim || null;
    if (claim) {
      lines.push(`Claim: ${claim.text || "-"}`);
      lines.push(`Person: ${claim.person_key || "-"}`);
      lines.push(`Dimension: ${claim.dimension || "-"}`);
      lines.push(`Type: ${claim.claim_type || "-"}`);
      lines.push("");
    }
    if (evidence) {
      const start = Number(evidence?.time_range_ms?.[0]);
      const end = Number(evidence?.time_range_ms?.[1]);
      lines.push(`Evidence ID: ${evidence.evidence_id || "-"}`);
      lines.push(`Speaker: ${evidence?.speaker?.display_name || evidence?.speaker?.cluster_id || "unknown"}`);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        lines.push(`Time: ${toClock(start)} - ${toClock(end)}`);
      }
      lines.push(`Quote: ${String(evidence.quote || "").trim() || "-"}`);
      lines.push("");
    }
    const contextItems = Array.isArray(payload?.context) ? payload.context : [];
    if (contextItems.length > 0) {
      lines.push("Context:");
      for (const item of contextItems) {
        const startMs = Number(item?.start_ms);
        const endMs = Number(item?.end_ms);
        const speaker = String(item?.speaker_name || item?.cluster_id || item?.stream_role || "unknown");
        const quote = String(item?.text || "").trim();
        lines.push(`[${toClock(startMs)}-${toClock(endMs)}] ${speaker}: ${quote}`);
      }
    } else {
      lines.push("Context: no transcript context available.");
    }
    evidenceModalContentEl.textContent = lines.join("\n");
  }
  if (evidenceModalEl) {
    evidenceModalEl.classList.remove("hidden");
    evidenceModalEl.setAttribute("aria-hidden", "false");
  }
}

function closeEvidenceModal() {
  selectedClaimContext = null;
  if (btnRegenerateClaim) {
    btnRegenerateClaim.disabled = true;
  }
  if (btnApplyClaimEvidence) {
    btnApplyClaimEvidence.disabled = true;
  }
  if (claimEvidenceRefsEl) {
    claimEvidenceRefsEl.value = "";
  }
  if (evidenceModalEl) {
    evidenceModalEl.classList.add("hidden");
    evidenceModalEl.setAttribute("aria-hidden", "true");
  }
}

function findClaimFromReport(report, personKey, dimension, claimType, claimId) {
  if (!report) return null;
  if (!personKey || !dimension || !claimType) return null;
  const people = Array.isArray(report?.per_person) ? report.per_person : [];
  const person = people.find((item) => String(item?.person_key || "") === personKey);
  if (!person) return null;
  const dim = Array.isArray(person?.dimensions)
    ? person.dimensions.find((item) => String(item?.dimension || "") === dimension)
    : null;
  if (!dim) return null;
  const claims = Array.isArray(dim?.[claimType]) ? dim[claimType] : [];
  if (!claims.length) return null;
  const claim = claimId
    ? claims.find((item) => String(item?.claim_id || "") === claimId) || claims[0]
    : claims[0];
  if (!claim) return null;
  return {
    claim_id: claim.claim_id,
    text: claim.text,
    claim_type: claimType,
    person_key: person.person_key,
    dimension: dim.dimension,
    evidence_refs: Array.isArray(claim.evidence_refs) ? claim.evidence_refs : []
  };
}

function transcriptContextForEvidence(report, evidenceId, size = 1) {
  if (!report || !evidenceId) return [];
  const evidence = Array.isArray(report?.evidence)
    ? report.evidence.find((item) => String(item?.evidence_id || "") === evidenceId)
    : null;
  if (!evidence) return [];
  const transcript = Array.isArray(report?.transcript) ? report.transcript : [];
  if (!transcript.length) return [];
  const utteranceIds = Array.isArray(evidence.utterance_ids) ? evidence.utterance_ids : [];
  const anchorIdx = transcript.findIndex((item) => utteranceIds.includes(item.utterance_id));
  if (anchorIdx < 0) {
    return [];
  }
  const startIdx = Math.max(0, anchorIdx - size);
  const endIdx = Math.min(transcript.length - 1, anchorIdx + size);
  return transcript.slice(startIdx, endIdx + 1);
}

function handleEvidenceChipClick(buttonEl) {
  const report = latestFeedbackReport;
  if (!report) return;
  const evidenceId = String(buttonEl.dataset.evidenceId || "").trim();
  if (!evidenceId) return;
  const evidence = Array.isArray(report?.evidence)
    ? report.evidence.find((item) => String(item?.evidence_id || "") === evidenceId)
    : null;
  const personKey = String(buttonEl.dataset.personKey || "").trim();
  const dimension = String(buttonEl.dataset.dimension || "").trim();
  const claimType = String(buttonEl.dataset.claimType || "").trim();
  const claimId = String(buttonEl.dataset.claimId || "").trim();
  const claim = findClaimFromReport(report, personKey, dimension, claimType, claimId);
  const context = transcriptContextForEvidence(report, evidenceId, 1);
  openEvidenceModal({
    evidence,
    claim,
    context
  });
}

async function applySelectedClaimEvidenceRefs() {
  if (!selectedClaimContext) {
    throw new Error("no claim selected");
  }
  const raw = String(claimEvidenceRefsEl?.value || "").trim();
  const refs = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!refs.length) {
    throw new Error("evidence refs cannot be empty");
  }
  const payload = await desktopAPI.updateFeedbackClaimEvidence({
    baseUrl: normalizeHttpBaseUrl(apiBaseUrlEl.value),
    sessionId: meetingIdValue(),
    body: {
      person_key: selectedClaimContext.person_key,
      dimension: selectedClaimContext.dimension,
      claim_type: selectedClaimContext.claim_type,
      claim_id: selectedClaimContext.claim_id,
      evidence_refs: refs
    }
  });
  await openFeedbackReport();
  logLine(`Claim evidence updated: person=${selectedClaimContext.person_key} dimension=${selectedClaimContext.dimension}`);
  return payload;
}

function chipHtml({
  evidenceId,
  personKey,
  dimension,
  claimType,
  claimId
}) {
  return `<button type="button" class="evidence-chip" data-evidence-id="${escapeHtml(evidenceId)}" data-person-key="${escapeHtml(
    personKey || ""
  )}" data-dimension="${escapeHtml(dimension || "")}" data-claim-type="${escapeHtml(
    claimType || ""
  )}" data-claim-id="${escapeHtml(claimId || "")}">${escapeHtml(evidenceId)}</button>`;
}

function renderClaimRows(person, dimension, claimType, claims) {
  const titleMap = {
    strengths: "Strengths",
    risks: "Risks",
    actions: "Actions"
  };
  const rows = claims
    .map((claim) => {
      const refs = Array.isArray(claim?.evidence_refs) ? claim.evidence_refs : [];
      const chips = refs
        .map((id) =>
          chipHtml({
            evidenceId: String(id),
            personKey: person.person_key,
            dimension: dimension.dimension,
            claimType,
            claimId: claim.claim_id
          })
        )
        .join("");
      return `
        <div class="claim-row">
          <div class="muted small">${escapeHtml(titleMap[claimType])}</div>
          <div>
            <div>${escapeHtml(claim?.text || "")}</div>
            <div class="claim-chip-group">${chips || "<span class='muted small'>No evidence</span>"}</div>
          </div>
        </div>
      `;
    })
    .join("");
  return rows || `<div class="muted small">No ${escapeHtml(titleMap[claimType])} claims.</div>`;
}

function renderReportV2(payload) {
  const report = payload?.report?.session ? payload.report : payload;
  latestFeedbackReport = report;
  if (!reportV2El) return;
  reportV2El.textContent = JSON.stringify(payload, null, 2);

  const overall = report?.overall || {};
  const people = Array.isArray(report?.per_person) ? report.per_person : [];
  const evidenceItems = Array.isArray(report?.evidence) ? report.evidence : [];
  const evidenceById = new Map();
  for (const item of evidenceItems) {
    if (item?.evidence_id) {
      evidenceById.set(String(item.evidence_id), item);
    }
  }

  if (reviewOverallEl) {
    const sections = Array.isArray(overall.summary_sections) ? overall.summary_sections : [];
    const sectionHtml = sections
      .map((section) => {
        const bullets = Array.isArray(section?.bullets) ? section.bullets : [];
        const evidenceIds = Array.isArray(section?.evidence_ids) ? section.evidence_ids : [];
        const lines = bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("");
        const chips = evidenceIds.map((id) => chipHtml({ evidenceId: String(id) })).join("");
        return `
          <article class="review-card">
            <strong>${escapeHtml(section?.topic || "topic")}</strong>
            <ul>${lines || "<li>No summary bullets.</li>"}</ul>
            <div class="claim-chip-group">${chips || "<span class='muted small'>No evidence refs</span>"}</div>
          </article>
        `;
      })
      .join("");
    const quality = payload?.quality || report?.quality || {};
    const timings = payload?.timings || {};
    const trace = report?.trace || {};
    const qualityGateFailures = Array.isArray(trace?.quality_gate_failures) ? trace.quality_gate_failures : [];
    const qualitySnapshot = trace?.quality_gate_snapshot || {};
    const reportSource = payload?.report_source || quality?.report_source || "memo_first";
    const blockingReason = payload?.blocking_reason || quality?.report_error || null;
    const echoRecentRate = Number(qualitySnapshot?.observed_echo_recent_rate ?? 0);
    const echoLeakRate = Number(qualitySnapshot?.observed_echo_leak_rate ?? 0);
    const suppressionFpRate = Number(qualitySnapshot?.observed_suppression_false_positive_rate ?? 0);
    const unknownRatio = Number(qualitySnapshot?.observed_unknown_ratio ?? 0);
    const echoQualityWarn = echoLeakRate > 0.2 || suppressionFpRate > 0.15;
    reviewOverallEl.innerHTML = `
      <div class="review-section">
        <div class="review-card">
          <strong>Session</strong>
          <div>session_id=${escapeHtml(report?.session?.session_id || "-")}</div>
          <div>tentative=${escapeHtml(String(report?.session?.tentative ?? false))}, unresolved=${escapeHtml(
      String(report?.session?.unresolved_cluster_count ?? 0)
    )}</div>
          <div class="muted small">quality.claims=${escapeHtml(String(quality?.claim_count ?? 0))} needs_evidence=${escapeHtml(
      String(quality?.needs_evidence_count ?? 0)
    )}</div>
          <div class="muted small">report_source=${escapeHtml(String(reportSource))}</div>
          <div class="muted small">timings(total=${escapeHtml(String(timings?.total_ms ?? 0))}ms, events=${escapeHtml(String(timings?.events_ms ?? 0))}ms, report=${escapeHtml(String(timings?.report_ms ?? 0))}ms)</div>
          <div class="muted small">quality.unknown_ratio=${escapeHtml((unknownRatio * 100).toFixed(2))}% | echo_recent_rate=${escapeHtml((echoRecentRate * 100).toFixed(2))}% | echo_leak_rate=${escapeHtml((echoLeakRate * 100).toFixed(2))}% | suppression_fp=${escapeHtml((suppressionFpRate * 100).toFixed(2))}%</div>
          ${
            echoQualityWarn
              ? `<div class="muted small">串音指标异常：建议人工复核，不建议直接使用强归因结论。</div>`
              : ""
          }
          ${blockingReason ? `<div class="muted small">blocking_reason=${escapeHtml(String(blockingReason))}</div>` : ""}
          ${
            qualityGateFailures.length
              ? `<div class="muted small">quality_gate_failures=${escapeHtml(qualityGateFailures.slice(0, 3).join(" | "))}</div>`
              : ""
          }
        </div>
        ${sectionHtml || "<div class='review-card'>No overall summary sections.</div>"}
      </div>
    `;
  }

  if (reviewPerPersonEl) {
    const peopleHtml = people
      .map((person) => {
        const dimensions = Array.isArray(person?.dimensions) ? person.dimensions : [];
        const dimensionHtml = dimensions
          .map((dimension) => {
            const strengths = Array.isArray(dimension?.strengths) ? dimension.strengths : [];
            const risks = Array.isArray(dimension?.risks) ? dimension.risks : [];
            const actions = Array.isArray(dimension?.actions) ? dimension.actions : [];
            return `
              <section class="dimension-block">
                <strong>${escapeHtml(dimension?.dimension || "dimension")}</strong>
                ${renderClaimRows(person, dimension, "strengths", strengths)}
                ${renderClaimRows(person, dimension, "risks", risks)}
                ${renderClaimRows(person, dimension, "actions", actions)}
              </section>
            `;
          })
          .join("");
        const summary = person?.summary || {};
        const summaryStrengths = (summary.strengths || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
        const summaryRisks = (summary.risks || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
        const summaryActions = (summary.actions || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
        return `
          <article class="review-person">
            <h3>${escapeHtml(person?.display_name || person?.person_key || "Unknown")}</h3>
            ${dimensionHtml || "<div class='muted'>No dimensions yet.</div>"}
            <div class="review-card">
              <strong>Summary</strong>
              <div><strong>Strengths</strong><ul>${summaryStrengths || "<li>None</li>"}</ul></div>
              <div><strong>Risks</strong><ul>${summaryRisks || "<li>None</li>"}</ul></div>
              <div><strong>Actions</strong><ul>${summaryActions || "<li>None</li>"}</ul></div>
            </div>
          </article>
        `;
      })
      .join("");
    reviewPerPersonEl.innerHTML = `<div class="review-section">${peopleHtml || "<div class='review-card'>No per-person feedback available.</div>"}</div>`;
  }

  if (reviewEvidenceEl) {
    const evidenceHtml = evidenceItems
      .slice(0, 200)
      .map((item) => {
        const range =
          Array.isArray(item?.time_range_ms) && item.time_range_ms.length === 2
            ? `${toClock(item.time_range_ms[0])}-${toClock(item.time_range_ms[1])}`
            : "--:--";
        const quote = item?.quote ? escapeHtml(String(item.quote)) : "";
        const speakerLabel = item?.speaker?.display_name || item?.speaker?.cluster_id || "unknown";
        const weakBadge = item?.weak ? `<span class="muted small">weak evidence (${escapeHtml(String(item?.weak_reason || "overlap_risk"))})</span>` : "";
        const chip = chipHtml({ evidenceId: String(item?.evidence_id || "evidence") });
        return `
          <article class="review-card">
            <div><strong>${escapeHtml(item?.evidence_id || "evidence")}</strong> @ ${range}</div>
            <div class="muted small">${escapeHtml(speakerLabel)}</div>
            ${weakBadge}
            <div>${quote || "<span class='muted'>No quote.</span>"}</div>
            <div class="claim-chip-group">${chip}</div>
          </article>
        `;
      })
      .join("");
    reviewEvidenceEl.innerHTML = `<div class="review-section">${evidenceHtml || "<div class='review-card'>No evidence captured.</div>"}</div>`;
  }

  openReviewPanel("overall");
}

function openReviewPanel(tab = "overall") {
  if (!reviewPanelEl) return;
  reviewPanelEl.classList.remove("hidden");
  currentReviewTab = tab;
  const isOverall = tab === "overall";
  const isPerson = tab === "person";
  const isEvidence = tab === "evidence";
  if (reviewOverallEl) reviewOverallEl.classList.toggle("hidden", !isOverall);
  if (reviewPerPersonEl) reviewPerPersonEl.classList.toggle("hidden", !isPerson);
  if (reviewEvidenceEl) reviewEvidenceEl.classList.toggle("hidden", !isEvidence);
  if (reviewTabOverallBtn) reviewTabOverallBtn.classList.toggle("tab-active", isOverall);
  if (reviewTabPersonBtn) reviewTabPersonBtn.classList.toggle("tab-active", isPerson);
  if (reviewTabEvidenceBtn) reviewTabEvidenceBtn.classList.toggle("tab-active", isEvidence);
}

function toggleDebugDrawer(forceValue) {
  if (!debugDrawerEl) return;
  const next = typeof forceValue === "boolean" ? forceValue : !debugDrawerEl.classList.contains("open");
  debugDrawerEl.classList.toggle("open", next);
}

function switchDebugTab(name) {
  for (const button of debugTabButtons) {
    const active = button.dataset.debugTabBtn === name;
    button.classList.toggle("tab-active", active);
  }
  for (const pane of document.querySelectorAll(".debug-tab-pane")) {
    pane.classList.toggle("hidden", pane.id !== `debug-tab-${name}`);
  }
}

function renderParticipantLiveMetrics(snapshot) {
  if (!participantLiveListEl) return;
  const rows = snapshot?.participants || [];
  if (!rows.length) {
    participantLiveListEl.innerHTML = `<p class="muted">No participant metrics yet.</p>`;
    return;
  }
  const html = rows
    .map((item) => {
      const speakingClass = item.speaking_now ? "speaking" : "idle";
      const speakingLabel = item.speaking_now ? "Speaking" : "Idle";
      const talkPct = Math.round((Number(item.talk_share || 0) * 1000)) / 10;
      return `
        <article class="participant-card">
          <div class="participant-card-head">
            <strong>${escapeHtml(item.display_name || item.person_key || "unknown")}</strong>
            <span class="badge ${speakingClass}">${speakingLabel}</span>
          </div>
          <div class="participant-metrics">
            <div>Engagement: <strong>${escapeHtml(String(item.engagement_score ?? 0))}</strong></div>
            <div>Talk: <strong>${escapeHtml(String(talkPct))}%</strong></div>
            <div>Turns: <strong>${escapeHtml(String(item.turns ?? 0))}</strong></div>
            <div>Support: <strong>${escapeHtml(String(item.support_count ?? 0))}</strong></div>
            <div>Interrupt: <strong>${escapeHtml(String(item.interruptions ?? 0))}</strong></div>
            <div>Duration: <strong>${escapeHtml(String(Math.round((item.talk_time_ms || 0) / 1000)))}s</strong></div>
          </div>
        </article>
      `;
    })
    .join("");
  participantLiveListEl.innerHTML = html;
}

async function refreshGraphStatus() {
  if (!graphStatusEl) return;
  try {
    const status = await desktopAPI.calendarGetStatus();
    graphStatusEl.textContent = JSON.stringify(status, null, 2);
    return status;
  } catch (error) {
    graphStatusEl.textContent = `Graph status failed: ${error.message}`;
    throw error;
  }
}

async function saveGraphConfig() {
  const clientId = String(graphClientIdEl?.value || "").trim();
  const tenantId = String(graphTenantIdEl?.value || "common").trim() || "common";
  if (!clientId) {
    throw new Error("Azure App Client ID is required");
  }
  const status = await desktopAPI.calendarSetConfig({ clientId, tenantId });
  writeJsonStorage("if.desktop.graph.config", { clientId, tenantId });
  graphStatusEl.textContent = JSON.stringify(status, null, 2);
  logLine(`Graph config saved: tenant=${tenantId}`);
  return status;
}

async function connectGraphCalendar() {
  await saveGraphConfig();
  if (graphStatusEl) {
    graphStatusEl.textContent = "Waiting for device-code login...";
  }
  const result = await desktopAPI.calendarConnectMicrosoft();
  logLine(`Graph connected: ${result?.account?.username || "unknown"}`);
  await refreshGraphStatus();
  return result;
}

async function syncMeetingsFromGraph() {
  await saveGraphConfig();
  const payload = await desktopAPI.calendarGetUpcomingMeetings({ days: 3 });
  const remoteMeetings = Array.isArray(payload?.meetings) ? payload.meetings : [];
  dashboardMeetings = mergeMeetingsById([
    ...dashboardMeetings.filter((item) => item.source !== "graph"),
    ...remoteMeetings
  ]);
  persistDashboardMeetings();
  renderMeetingList();
  logLine(`Graph meetings synced: ${remoteMeetings.length}`);
  await refreshGraphStatus();
  return payload;
}

async function disconnectGraphCalendar() {
  await desktopAPI.calendarDisconnectMicrosoft();
  await refreshGraphStatus();
  logLine("Graph disconnected.");
}

async function createMeetingWithGraph() {
  await saveGraphConfig();
  const subject = String(dashboardMeetingTitleEl?.value || "").trim() || "Group Interview Session";
  const startRaw = String(dashboardMeetingStartEl?.value || "").trim();
  const startAt = startRaw ? new Date(startRaw).toISOString() : "";
  const participants = parseParticipantLines(dashboardMeetingParticipantsEl?.value || "").map((name) => ({ name }));
  const payload = await desktopAPI.calendarCreateOnlineMeeting({
    subject,
    startAt,
    participants
  });
  dashboardMeetings = mergeMeetingsById([...dashboardMeetings, payload]);
  persistDashboardMeetings();
  renderMeetingList();
  if (dashboardMeetingUrlEl) {
    dashboardMeetingUrlEl.value = String(payload?.join_url || "");
  }
  if (payload?.join_url) {
    updateSessionConfigOverrides({ teams_join_url: payload.join_url, mode: "group" });
  }
  logLine(`Graph online meeting created: ${payload?.meeting_id || "unknown"}`);
  await refreshGraphStatus();
  return payload;
}

function setFeedbackSlaText(message, warn = false) {
  if (!flowFeedbackSlaEl) return;
  flowFeedbackSlaEl.textContent = message;
  flowFeedbackSlaEl.style.color = warn ? "#9b2f2f" : "";
}

function reportFromPayload(payload) {
  if (!payload) return null;
  if (payload.report && payload.report.session) return payload.report;
  if (payload.session) return payload;
  return null;
}

async function checkFeedbackReady() {
  const payload = await desktopAPI.getFeedbackReady({
    baseUrl: normalizeHttpBaseUrl(apiBaseUrlEl.value),
    sessionId: meetingIdValue()
  });
  const totalMs = Number(payload?.timings?.total_ms || 0);
  const ready = Boolean(payload?.ready);
  const source = String(payload?.report_source || payload?.quality?.report_source || "memo_first");
  const blockingReason = String(payload?.blocking_reason || "").trim();
  const statusText = `Ready=${ready} source=${source} total=${totalMs}ms / target<=8000ms`;
  setFeedbackSlaText(statusText, !ready || totalMs > 8000);
  if (blockingReason) {
    logLine(`feedback-ready blocking_reason=${blockingReason}`);
  }
  setResultPayload(payload);
  logLine(`feedback-ready checked: ready=${ready} total_ms=${totalMs}`);
  return payload;
}

async function openFeedbackReport() {
  const openedAt = Date.now();
  const payload = await desktopAPI.openFeedback({
    baseUrl: normalizeHttpBaseUrl(apiBaseUrlEl.value),
    sessionId: meetingIdValue(),
    body: {}
  });
  const serverMs = Number(payload?.opened_in_ms || 0);
  const elapsedMs = serverMs > 0 ? serverMs : Date.now() - openedAt;
  const ready = Boolean(payload?.ready);
  const source = String(payload?.report_source || payload?.quality?.report_source || "memo_first");
  const blockingReason = String(payload?.blocking_reason || "").trim();
  setFeedbackSlaText(
    `Opened in ${elapsedMs}ms / target<=8000ms / ready=${ready} / source=${source}`,
    elapsedMs > 8000 || !ready
  );
  if (blockingReason) {
    logLine(`Open feedback blocking_reason=${blockingReason}`);
  }
  const report = reportFromPayload(payload);
  if (!report) {
    throw new Error("feedback-open returned no report payload");
  }
  renderReportV2(payload);
  setResultPayload(payload);
  openReviewPanel("overall");
  logLine(`feedback-open completed in ${elapsedMs}ms`);
  return payload;
}

function base64ToBytes(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function triggerDownload(fileName, bytes, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
}

async function copyTextToClipboard(content) {
  const text = String(content || "");
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  return ok;
}

async function exportFeedback(format) {
  const payload = await desktopAPI.exportFeedback({
    baseUrl: normalizeHttpBaseUrl(apiBaseUrlEl.value),
    sessionId: meetingIdValue(),
    body: { format }
  });
  if (payload?.format === "plain_text") {
    const copied = await copyTextToClipboard(payload.content || "");
    if (!copied) {
      throw new Error("failed to copy plain text report");
    }
    logLine("Feedback plain text copied to clipboard.");
    setResultPayload({
      export: "plain_text",
      copied: true,
      file_name: payload?.file_name || ""
    });
    return payload;
  }
  if (payload?.encoding === "utf-8") {
    triggerDownload(payload.file_name || `feedback.${format === "markdown" ? "md" : "txt"}`, payload.content || "", payload.mime_type || "text/plain; charset=utf-8");
    logLine(`Feedback exported: ${payload.file_name || "report"}`);
    return payload;
  }
  if (payload?.encoding === "base64") {
    const bytes = base64ToBytes(String(payload.content || ""));
    triggerDownload(payload.file_name || "feedback.docx", bytes, payload.mime_type || "application/octet-stream");
    logLine(`Feedback exported: ${payload.file_name || "feedback.docx"}`);
    return payload;
  }
  throw new Error("unsupported export payload");
}

async function regenerateSelectedClaim() {
  if (!selectedClaimContext) {
    throw new Error("no claim selected");
  }
  const defaultHint = String(selectedClaimContext.text || "").trim();
  const hint = window.prompt("Optional hint for this claim regeneration:", defaultHint);
  const payload = await desktopAPI.regenerateFeedbackClaim({
    baseUrl: normalizeHttpBaseUrl(apiBaseUrlEl.value),
    sessionId: meetingIdValue(),
    body: {
      person_key: selectedClaimContext.person_key,
      dimension: selectedClaimContext.dimension,
      claim_type: selectedClaimContext.claim_type,
      claim_id: selectedClaimContext.claim_id,
      text_hint: hint === null ? undefined : String(hint || "").trim()
    }
  });
  await openFeedbackReport();
  logLine(`Claim regenerated: person=${selectedClaimContext.person_key} dimension=${selectedClaimContext.dimension}`);
  return payload;
}

async function handleDeepLinkStart(payload) {
  const sessionId = sanitizeMeetingId(payload?.session_id || meetingIdValue());
  if (meetingIdEl) {
    meetingIdEl.value = sessionId;
  }
  const mode = String(payload?.mode || "").trim();
  const templateId = String(payload?.template_id || "").trim();
  const bookingRef = String(payload?.booking_ref || "").trim();
  const teamsJoinUrl = String(payload?.teams_join_url || "").trim();
  updateSessionConfigOverrides({
    mode,
    template_id: templateId,
    booking_ref: bookingRef,
    teams_join_url: teamsJoinUrl
  });
  const participants = Array.isArray(payload?.participants) ? payload.participants : [];
  const names = participants
    .map((item) => (typeof item === "string" ? item : item?.name))
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (names.length > 0) {
    setParticipantsInUI(names);
  }
  const item = {
    source: "deeplink",
    meeting_id: sessionId,
    title: bookingRef || templateId || sessionId,
    start_at: new Date().toISOString(),
    end_at: "",
    join_url: teamsJoinUrl,
    participants: names.map((name) => ({ name }))
  };
  dashboardMeetings = mergeMeetingsById([...dashboardMeetings, item]);
  persistDashboardMeetings();
  renderMeetingList();
  await saveSessionConfig({
    mode,
    template_id: templateId,
    booking_ref: bookingRef,
    teams_join_url: teamsJoinUrl
  });
  if (teamsJoinUrl) {
    await desktopAPI.openExternalUrl({ url: teamsJoinUrl });
  }
  setAppMode("session");
  setUploadStatus("Session initialized by deep link. Start audio and upload when Teams call is ready.");
  logLine(`Deep link loaded: session=${sessionId} mode=${mode || "1v1"} participants=${names.length}`);
}

function addMeetingFromDashboardForm() {
  const title = String(dashboardMeetingTitleEl?.value || "").trim();
  if (!title) {
    throw new Error("Meeting title is required");
  }
  const startRaw = String(dashboardMeetingStartEl?.value || "").trim();
  const startAt = startRaw ? new Date(startRaw).toISOString() : "";
  const participants = parseParticipantLines(dashboardMeetingParticipantsEl?.value || "").map((name) => ({ name }));
  const item = {
    source: "manual",
    meeting_id: sanitizeMeetingId(`${title}-${Date.now()}`),
    title,
    start_at: startAt,
    end_at: "",
    join_url: String(dashboardMeetingUrlEl?.value || "").trim(),
    participants
  };
  if (item.join_url) {
    updateSessionConfigOverrides({ teams_join_url: item.join_url });
  }
  dashboardMeetings = mergeMeetingsById([...dashboardMeetings, item]);
  persistDashboardMeetings();
  renderMeetingList();
  if (dashboardMeetingTitleEl) dashboardMeetingTitleEl.value = "";
  if (dashboardMeetingStartEl) dashboardMeetingStartEl.value = "";
  if (dashboardMeetingUrlEl) dashboardMeetingUrlEl.value = "";
  if (dashboardMeetingParticipantsEl) dashboardMeetingParticipantsEl.value = "";
  logLine(`Dashboard meeting added: ${item.title}`);
  return item;
}

async function triggerFinalizeV2() {
  if (finalizeV2PollTimer) {
    window.clearInterval(finalizeV2PollTimer);
    finalizeV2PollTimer = undefined;
  }
  const payload = await desktopAPI.finalizeV2({
    baseUrl: normalizeHttpBaseUrl(apiBaseUrlEl.value),
    sessionId: meetingIdValue(),
    metadata: {
      source: "desktop-ui"
    }
  });
  finalizeV2JobId = String(payload.job_id || "");
  setFinalizeStatus({ status: "queued", stage: "queued", progress: 0 });
  logLine(`Finalize v2 queued: job=${finalizeV2JobId}`);

  finalizeV2PollTimer = window.setInterval(async () => {
    try {
      const status = await desktopAPI.getFinalizeStatus({
        baseUrl: normalizeHttpBaseUrl(apiBaseUrlEl.value),
        sessionId: meetingIdValue(),
        jobId: finalizeV2JobId
      });
      setFinalizeStatus(status);
      if (status.status === "succeeded") {
        window.clearInterval(finalizeV2PollTimer);
        finalizeV2PollTimer = undefined;
        const resultV2 = await desktopAPI.getResultV2({
          baseUrl: normalizeHttpBaseUrl(apiBaseUrlEl.value),
          sessionId: meetingIdValue()
        });
        renderReportV2(resultV2);
        setResultPayload(resultV2);
        logLine("Finalize v2 report loaded.");
      } else if (status.status === "failed") {
        window.clearInterval(finalizeV2PollTimer);
        finalizeV2PollTimer = undefined;
        throw new Error(`finalize v2 failed: ${JSON.stringify(status.errors || [])}`);
      }
    } catch (error) {
      if (finalizeV2PollTimer) {
        window.clearInterval(finalizeV2PollTimer);
        finalizeV2PollTimer = undefined;
      }
      setFinalizeStatus({ status: "failed", stage: "persist", progress: 100, errors: [error.message] });
      logLine(`Finalize v2 polling failed: ${error.message}`);
    }
  }, 2000);
}

async function refreshSidecarStatus() {
  if (!sidecarStatusEl) return;
  lastSidecarHealthRefreshMs = Date.now();
  try {
    const status = await desktopAPI.diarizationGetStatus();
    sidecarActive = Boolean(status?.status === "running" && status?.healthy);
    sidecarStatusEl.textContent = JSON.stringify(status, null, 2);
    if (!sidecarActive && effectiveDiarizationBackend() === "edge") {
      backendSwitchState.edgeFailureStreak += 1;
    }
  } catch (error) {
    sidecarActive = false;
    sidecarStatusEl.textContent = `sidecar status failed: ${error.message}`;
    if (effectiveDiarizationBackend() === "edge") {
      backendSwitchState.edgeFailureStreak += 1;
    }
  }
  updateBackendBadge();
}

async function refreshSidecarStatusIfNeeded(force = false) {
  const nowMs = Date.now();
  if (!force && nowMs - lastSidecarHealthRefreshMs < SIDECAR_HEALTH_REFRESH_MS) {
    return;
  }
  await refreshSidecarStatus();
}

async function requestAttachToTeams() {
  const status = await desktopAPI.attachToTeams();
  renderAttachStatus(status);
  if (status?.status === "permission_required") {
    const reason = humanizeAttachReason(status?.reason);
    setUploadStatus(`Attach blocked by permission. ${reason} Open Accessibility and Automation settings, then restart app.`);
    logLine(`Attach permission required: ${reason || "unknown reason"}`);
  } else if (status?.status === "teams_not_found") {
    setUploadStatus("Teams meeting window not found. Open Teams meeting and click Attach again.");
  }
  if (status?.status === "attached" && appMode !== "session") {
    setAppMode("session");
    setUploadStatus("Attached to Teams. Initialize mic/system audio to start session.");
  }
  updateButtons();
  return status;
}

async function requestDetachFromTeams() {
  const status = await desktopAPI.detachFromTeams();
  renderAttachStatus(status);
  if (appMode !== "dashboard") {
    setAppMode("dashboard");
  }
  updateButtons();
  return status;
}

async function refreshAttachStatus() {
  try {
    const status = await desktopAPI.getAttachStatus();
    renderAttachStatus(status);
    if (status?.status === "attached" && appMode !== "session") {
      setAppMode("session");
    }
  } catch (error) {
    renderAttachStatus({ status: "error", reason: error?.message || String(error) });
  }
  updateButtons();
}

function startAttachPolling() {
  if (attachPollTimer) {
    window.clearInterval(attachPollTimer);
    attachPollTimer = undefined;
  }
  attachPollTimer = window.setInterval(() => {
    refreshAttachStatus().catch((error) => {
      logLine(`Attach status refresh failed: ${error.message}`);
    });
  }, 1000);
}

function stopAttachPolling() {
  if (!attachPollTimer) return;
  window.clearInterval(attachPollTimer);
  attachPollTimer = undefined;
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

function resetEchoCalibrationState() {
  echoCalibrationState.active = false;
  echoCalibrationState.startedAtMs = 0;
  echoCalibrationState.corrSamples = [];
  echoCalibrationState.ratioSamples = [];
  echoCalibrationState.softCorr = ECHO_CORR_THRESHOLD;
  echoCalibrationState.strongCorr = ECHO_STRONG_CORR_THRESHOLD;
  echoCalibrationState.teacherRatio = ECHO_TEACHER_STUDENT_RMS_RATIO;
  echoCalibrationState.calibrated = false;
  echoCalibrationState.holdUntilMs = 0;
}

function startEchoCalibration() {
  echoCalibrationState.active = true;
  echoCalibrationState.startedAtMs = Date.now();
  echoCalibrationState.corrSamples = [];
  echoCalibrationState.ratioSamples = [];
  echoCalibrationState.softCorr = ECHO_CORR_THRESHOLD;
  echoCalibrationState.strongCorr = ECHO_STRONG_CORR_THRESHOLD;
  echoCalibrationState.teacherRatio = ECHO_TEACHER_STUDENT_RMS_RATIO;
  echoCalibrationState.calibrated = false;
  echoCalibrationState.holdUntilMs = 0;
}

function updateEchoCalibration(timestampMs, corrValue, rmsRatio, studentRms) {
  if (!echoCalibrationState.active) return;
  if (studentRms < ECHO_STUDENT_MIN_RMS) return;
  if (Number.isFinite(corrValue) && corrValue > 0) {
    echoCalibrationState.corrSamples.push(corrValue);
  }
  if (Number.isFinite(rmsRatio) && rmsRatio > 0 && rmsRatio < 8) {
    echoCalibrationState.ratioSamples.push(rmsRatio);
  }
  while (echoCalibrationState.corrSamples.length > 280) {
    echoCalibrationState.corrSamples.shift();
  }
  while (echoCalibrationState.ratioSamples.length > 280) {
    echoCalibrationState.ratioSamples.shift();
  }
  if (timestampMs - echoCalibrationState.startedAtMs < ECHO_CALIBRATION_MS) {
    return;
  }
  const corrP70 = percentileValue(echoCalibrationState.corrSamples, 70);
  const corrP90 = percentileValue(echoCalibrationState.corrSamples, 90);
  const ratioP75 = percentileValue(echoCalibrationState.ratioSamples, 75);
  echoCalibrationState.softCorr = clampNumber(
    Math.max(ECHO_DYNAMIC_CORR_FLOOR, corrP70 - 0.03),
    ECHO_DYNAMIC_CORR_FLOOR,
    ECHO_DYNAMIC_CORR_CEIL
  );
  echoCalibrationState.strongCorr = clampNumber(
    Math.max(echoCalibrationState.softCorr + 0.08, corrP90 + 0.02),
    ECHO_DYNAMIC_CORR_FLOOR + 0.1,
    0.97
  );
  echoCalibrationState.teacherRatio = clampNumber(
    ratioP75 + 0.08,
    ECHO_DYNAMIC_RATIO_FLOOR,
    ECHO_DYNAMIC_RATIO_CEIL
  );
  echoCalibrationState.active = false;
  echoCalibrationState.calibrated = true;
  logLine(
    `Echo calibration ready: soft_corr=${echoCalibrationState.softCorr.toFixed(3)} ` +
      `strong_corr=${echoCalibrationState.strongCorr.toFixed(3)} ` +
      `ratio=${echoCalibrationState.teacherRatio.toFixed(2)}`
  );
}

function currentEchoThresholds(timestampMs) {
  if (echoCalibrationState.active && timestampMs - echoCalibrationState.startedAtMs >= ECHO_CALIBRATION_MS) {
    updateEchoCalibration(timestampMs, Number.NaN, Number.NaN, ECHO_STUDENT_MIN_RMS);
  }
  return {
    softCorr: echoCalibrationState.softCorr,
    strongCorr: echoCalibrationState.strongCorr,
    teacherRatio: echoCalibrationState.teacherRatio
  };
}

function isDoubleTalk(teacherRms, studentRms) {
  if (teacherRms < ECHO_DOUBLE_TALK_MIN_RMS || studentRms < ECHO_DOUBLE_TALK_MIN_RMS) {
    return false;
  }
  const ratio = teacherRms / Math.max(studentRms, 1e-6);
  return ratio >= ECHO_DOUBLE_TALK_RATIO_LOW && ratio <= ECHO_DOUBLE_TALK_RATIO_HIGH;
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
  const rmsRatio = best.studentRms > 0 ? teacherRms / best.studentRms : Number.POSITIVE_INFINITY;
  updateEchoCalibration(timestampMs, best.corr, rmsRatio, best.studentRms);
  const thresholds = currentEchoThresholds(timestampMs);
  const ratioThreshold = best.studentRms > 0 ? best.studentRms * thresholds.teacherRatio : 0;
  const teacherDominant =
    best.studentRms > 0 && teacherRms >= best.studentRms * ECHO_TEACHER_DOMINANT_RMS_RATIO;
  const doubleTalk = isDoubleTalk(teacherRms, best.studentRms);
  const hardLeak =
    hasStudentEnergy &&
    best.corr >= thresholds.strongCorr &&
    Math.abs(best.lagMs) <= ECHO_MAX_LAG_MS;
  const softLeak =
    hasStudentEnergy &&
    best.corr >= thresholds.softCorr &&
    Math.abs(best.lagMs) <= ECHO_MAX_LAG_MS &&
    teacherRms <= ratioThreshold;
  const holdLeak =
    hasStudentEnergy &&
    timestampMs <= echoCalibrationState.holdUntilMs &&
    best.corr >= Math.max(ECHO_DYNAMIC_CORR_FLOOR, thresholds.softCorr - 0.06) &&
    Math.abs(best.lagMs) <= ECHO_MAX_LAG_MS + 40 &&
    !teacherDominant;
  const shouldSuppress = !teacherDominant && !doubleTalk && (hardLeak || softLeak || holdLeak);
  if (shouldSuppress) {
    const holdMs = hardLeak ? ECHO_HOLD_MS : ECHO_HOLD_DECAY_MS;
    echoCalibrationState.holdUntilMs = timestampMs + holdMs;
  } else if (timestampMs > echoCalibrationState.holdUntilMs) {
    echoCalibrationState.holdUntilMs = 0;
  }

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
  const mode = hardLeak ? "hard" : holdLeak ? "hold" : "soft";
  logLine(
    `Teacher echo suppressed (${mode}): corr=${best.corr.toFixed(3)} lag_ms=${Math.round(best.lagMs)} ` +
      `teacher_rms=${teacherRms.toFixed(4)} student_rms=${best.studentRms.toFixed(4)} ratio=` +
      `${Number.isFinite(rmsRatio) ? rmsRatio.toFixed(2) : "inf"} ` +
      `th=[${thresholds.softCorr.toFixed(2)},${thresholds.strongCorr.toFixed(2)}]` +
      ` calib=${echoCalibrationState.calibrated ? "on" : "warming"}`
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

async function handleEdgeDiarizationFailure(reason) {
  if (backendSwitchState.autoSwitchInFlight) {
    return;
  }
  backendSwitchState.autoSwitchInFlight = true;
  try {
    sidecarActive = false;
    backendSwitchState.edgeFailureStreak += 1;
    backendSwitchState.edgeRecoveryStreak = 0;
    backendSwitchState.lastReason = `edge diarization failed: ${reason}`;
    updateBackendBadge();
    logLine(`Edge diarization failure: ${reason}`);
    if (backendSwitchState.autoEnabled) {
      const switched = await switchDiarizationBackend("cloud", backendSwitchState.lastReason, {
        automatic: true,
        persist: true,
        skipCooldown: true
      });
      if (switched) {
        setUploadStatus(`Edge diarization failed, auto-switched to cloud: ${reason}`);
        return;
      }
    }
    setUploadStatus(`Edge diarization failed: ${reason}. Upload will stop.`);
    stopUpload("edge-sidecar-failed");
  } finally {
    backendSwitchState.autoSwitchInFlight = false;
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

    if (role === "students" && effectiveDiarizationBackend() === "edge" && !sidecarActive) {
      if (!backendSwitchState.autoSwitchInFlight) {
        void handleEdgeDiarizationFailure("sidecar inactive");
      }
    }

    if (role === "students" && effectiveDiarizationBackend() === "edge" && sidecarActive) {
      let diarizationBaseUrl = "";
      try {
        diarizationBaseUrl = normalizeHttpBaseUrl(apiBaseUrlEl.value);
      } catch (error) {
        logLine(`Edge diarization skipped: ${error.message}`);
        diarizationBaseUrl = "";
      }
      if (diarizationBaseUrl) {
        desktopAPI
          .diarizationPushChunk({
            baseUrl: diarizationBaseUrl,
            sessionId: meetingIdValue(),
            seq: uploadSeq[role],
            timestampMs,
            content_b64: contentB64
          })
          .then((resp) => {
            if (resp?.upload) {
              logLine(`Edge diarization uploaded speaker-logs turns=${resp.upload.turns || 0}`);
            }
          })
          .catch((error) => {
            void handleEdgeDiarizationFailure(error.message);
          });
      }
    }

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
        sessionStartedAtMs = 0;
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
      sessionStartedAtMs = 0;
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
  if (attachStatus.status !== "attached") {
    throw new Error("Teams window must be attached before starting upload");
  }
  if (effectiveDiarizationBackend() === "edge") {
    const sidecarReady = await ensureSidecarRunning("start-upload");
    if (!sidecarReady) {
      throw new Error("diarization backend=edge requires sidecar running");
    }
  }
  if (isAnyUploadActive()) {
    throw new Error("upload already started");
  }
  backendSwitchState.cloudFailureStreak = 0;
  backendSwitchState.cloudRecoveryStreak = 0;
  backendSwitchState.edgeFailureStreak = 0;
  backendSwitchState.edgeRecoveryStreak = 0;
  suppressAutoRecover = false;
  recentStudentsChunks.length = 0;
  recentEchoSuppression.length = 0;
  resetEchoCalibrationState();
  startEchoCalibration();
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
    sessionStartedAtMs = Date.now();
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
  sessionStartedAtMs = 0;
  resetEchoCalibrationState();
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

function formatUtteranceLines(title, response, role, eventIndex) {
  if (typeof transcriptFormatter.formatUtterancesByRole === "function") {
    return transcriptFormatter.formatUtterancesByRole({
      title,
      response,
      role,
      eventIndex
    });
  }
  const header = `${title} (count=${response.count})`;
  const lines = (response.items || []).slice(-8).map((item) => {
    const seq = `${item.start_seq}-${item.end_seq}`;
    return `[${seq}] ${item.text}`;
  });
  return [header, ...lines].join("\n");
}

function formatEvents(response) {
  if (typeof transcriptFormatter.formatEvents === "function") {
    return transcriptFormatter.formatEvents(response);
  }
  const header = `events count=${response.count}`;
  const lines = (response.items || []).slice(-20).map((item) => `${item.ts} ${item.source || "unknown"}`);
  return [header, ...lines].join("\n");
}

function renderEnrollmentStatus(payload) {
  if (!enrollmentStatusEl) return;
  const state = payload?.enrollment_state || {};
  const participants = state.participants || {};
  const rows = Object.values(participants)
    .slice(0, 20)
    .map((item) => {
      const seconds = Number.isFinite(item.sample_seconds) ? Number(item.sample_seconds).toFixed(1) : "0.0";
      const count = Number.isFinite(item.sample_count) ? Number(item.sample_count) : 0;
      return `${item.name}: ${seconds}s / ${count} samples / ${item.status}`;
    });
  enrollmentStatusEl.textContent = [
    `mode=${state.mode || "idle"}`,
    `started_at=${state.started_at || "-"}`,
    `stopped_at=${state.stopped_at || "-"}`,
    ...rows
  ].join("\n");
}

function participantNamesForMapping(statePayload) {
  const names = [];
  const seen = new Set();
  const fromUi = parseParticipantsFromUI();
  for (const item of fromUi) {
    const name = String(item.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  const roster = statePayload?.state?.roster || [];
  for (const item of roster) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function renderClusterMappings(unresolvedPayload, statePayload) {
  if (!clusterMapListEl) return;
  const items = unresolvedPayload?.items || [];
  const candidates = participantNamesForMapping(statePayload);
  if (!items.length) {
    clusterMapListEl.innerHTML = `<p class="muted">No unresolved clusters.</p>`;
    return;
  }
  const optionsHtml = candidates
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("");
  const rows = items.map((item) => {
    const suggested = String(item.bound_name || item.binding_meta?.participant_name || "");
    const selectedValue = suggested ? `data-selected="${escapeHtml(suggested)}"` : "";
    const text = item.latest_text ? escapeHtml(item.latest_text).slice(0, 200) : "";
    const locked = item.binding_meta?.locked === true;
    return `
      <div class="cluster-map-row">
        <div class="cluster-meta">
          <div><strong>${escapeHtml(item.cluster_id)}</strong> sample_count=${escapeHtml(item.sample_count)}</div>
          <div class="muted small">latest_decision=${escapeHtml(item.latest_decision || "-")} latest_ts=${escapeHtml(item.latest_ts || "-")}</div>
          <div class="muted small">latest_text=${text || "-"}</div>
        </div>
        <div class="cluster-actions">
          <select class="cluster-map-select" ${selectedValue}>${optionsHtml}</select>
          <label class="switch-line"><input class="cluster-map-lock" type="checkbox" ${locked ? "checked" : ""} /> lock</label>
          <button class="cluster-map-apply" data-cluster-id="${escapeHtml(item.cluster_id)}">Bind</button>
        </div>
      </div>
    `;
  });
  clusterMapListEl.innerHTML = rows.join("");
  for (const selectEl of clusterMapListEl.querySelectorAll(".cluster-map-select")) {
    const selected = selectEl.getAttribute("data-selected");
    if (selected) {
      selectEl.value = selected;
    }
  }
}

async function startEnrollment() {
  const names = effectiveInterviewerNames();
  const body = {
    participants: validateParticipantsInput(),
    interviewer_name: names.interviewerName,
    teams_interviewer_name: names.teamsInterviewerName
  };
  const payload = await apiRequest("enrollment/start", "POST", body);
  renderEnrollmentStatus(payload);
  setResultPayload(payload);
  logLine(`Enrollment started. participants=${Object.keys(payload.enrollment_state?.participants || {}).length}`);
}

async function stopEnrollment() {
  const payload = await apiRequest("enrollment/stop", "POST", {});
  renderEnrollmentStatus(payload);
  setResultPayload(payload);
  logLine(`Enrollment stopped. mode=${payload.enrollment_state?.mode || "unknown"}`);
}

async function refreshUnresolvedClusters(statePayload = null) {
  const unresolved = await apiRequest("unresolved-clusters", "GET");
  renderClusterMappings(unresolved, statePayload);
  return unresolved;
}

async function applyClusterMappingFromButton(buttonEl) {
  const rowEl = buttonEl.closest(".cluster-map-row");
  if (!rowEl) return;
  const clusterId = String(buttonEl.dataset.clusterId || "").trim();
  const selectEl = rowEl.querySelector(".cluster-map-select");
  const lockEl = rowEl.querySelector(".cluster-map-lock");
  const participantName = String(selectEl?.value || "").trim();
  if (!clusterId || !participantName) {
    throw new Error("cluster_id or participant_name is empty");
  }
  const payload = await apiRequest("cluster-map", "POST", {
    stream_role: "students",
    cluster_id: clusterId,
    participant_name: participantName,
    lock: Boolean(lockEl?.checked)
  });
  setResultPayload(payload);
  logLine(`Cluster mapped: ${clusterId} -> ${participantName} lock=${Boolean(lockEl?.checked)}`);
}

async function saveSessionConfig(overrides = {}) {
  updateSessionConfigOverrides(overrides);
  const names = effectiveInterviewerNames();
  const participants = validateParticipantsInput();
  const body = {
    participants,
    teams_participants: participants,
    teams_interviewer_name: names.teamsInterviewerName,
    interviewer_name: names.interviewerName,
    diarization_backend: effectiveDiarizationBackend(),
    mode: sessionConfigOverrides.mode || undefined,
    template_id: sessionConfigOverrides.template_id || undefined,
    booking_ref: sessionConfigOverrides.booking_ref || undefined,
    teams_join_url: sessionConfigOverrides.teams_join_url || undefined
  };
  const payload = await apiRequest("config", "POST", body);
  setResultPayload(payload);
  logLine(`Session config saved. roster_count=${payload.roster_count || 0}`);
  if (flowStageLabelEl && sessionConfigOverrides.mode) {
    flowStageLabelEl.textContent = `Mode: ${sessionConfigOverrides.mode.toUpperCase()} | Stage: Q1 in progress`;
  }
}

async function refreshLiveView() {
  const [state, teacherRaw, teacherMerged, studentsRaw, studentsMerged, events, enrollmentState, unresolved] = await Promise.all([
    apiRequest("state", "GET"),
    apiRequest("utterances?stream_role=teacher&view=raw&limit=50", "GET"),
    apiRequest("utterances?stream_role=teacher&view=merged&limit=50", "GET"),
    apiRequest("utterances?stream_role=students&view=raw&limit=50", "GET"),
    apiRequest("utterances?stream_role=students&view=merged&limit=50", "GET"),
    apiRequest("events?limit=100", "GET"),
    apiRequest("enrollment/state", "GET"),
    apiRequest("unresolved-clusters", "GET")
  ]);
  await refreshSidecarStatusIfNeeded(false).catch((error) => {
    logLine(`Sidecar health refresh failed: ${error.message}`);
  });
  await evaluateBackendHealthAndMaybeSwitch(state).catch((error) => {
    logLine(`Backend health state machine failed: ${error.message}`);
  });

  const eventItems = Array.isArray(events?.items) ? events.items : [];
  const eventIndex =
    typeof transcriptFormatter.buildEventIndex === "function"
      ? transcriptFormatter.buildEventIndex(eventItems)
      : new Map();

  liveTranscriptEl.textContent = [
    formatUtteranceLines("Teacher Raw", teacherRaw, "teacher", eventIndex),
    "",
    formatUtteranceLines("Teacher Merged", teacherMerged, "teacher", eventIndex),
    "",
    formatUtteranceLines("Students Raw", studentsRaw, "students", eventIndex),
    "",
    formatUtteranceLines("Students Merged", studentsMerged, "students", eventIndex),
    "",
    `Capture Teacher: ${JSON.stringify(state.capture_by_stream?.teacher || {})}`,
    `Capture Students: ${JSON.stringify(state.capture_by_stream?.students || {})}`,
    "",
    `Speech Backend Mode: ${JSON.stringify(state.speech_backend_mode || "unknown")}`,
    `Quality Metrics: ${JSON.stringify(state.quality_metrics || {})}`,
    "",
    `ASR Teacher: ${JSON.stringify(state.asr_by_stream?.teacher || {})}`,
    `ASR Students: ${JSON.stringify(state.asr_by_stream?.students || {})}`
  ].join("\n");
  speakerEventsEl.textContent = formatEvents(events);
  renderEnrollmentStatus(enrollmentState);
  renderClusterMappings(unresolved, state);
  setResultPayload(state);

  const stateRoster = Array.isArray(state?.state?.roster) ? state.state.roster : [];
  const timelineNowMs = Math.max(
    Number(state?.ingest_by_stream?.teacher?.last_seq || 0) * 1000,
    Number(state?.ingest_by_stream?.students?.last_seq || 0) * 1000
  );
  if (typeof liveMetricsEngine.computeParticipantMetrics === "function") {
    const metricsSnapshot = liveMetricsEngine.computeParticipantMetrics({
      roster: stateRoster,
      uiParticipants: parseParticipantsFromUI(),
      interviewerName: effectiveInterviewerNames().interviewerName,
      events: eventItems,
      teacherUtterances: teacherRaw?.items || [],
      studentsUtterances: studentsRaw?.items || [],
      timelineNowMs
    });
    renderParticipantLiveMetrics(metricsSnapshot);
    latestLiveSnapshot = {
      state,
      teacherRaw,
      teacherMerged,
      studentsRaw,
      studentsMerged,
      events,
      metrics: metricsSnapshot
    };
  } else {
    renderParticipantLiveMetrics({ participants: [] });
  }
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
  const requiredButtons = [
    btnInitMic,
    btnInitSystem,
    btnStartRecording,
    btnStopRecording,
    btnPickFile,
    btnNormalizeFile,
    btnOpenLastFile,
    btnStartUpload,
    btnStopUpload,
    btnFetchUploadStatus,
    btnSaveSessionConfig,
    btnRefreshLive
  ];
  if (requiredButtons.some((item) => !item)) {
    throw new Error("missing required UI controls in index.html");
  }

  if (diarizationBackendEl) {
    diarizationBackendEl.addEventListener("change", () => {
      const selected = normalizeBackend(diarizationBackendEl.value);
      backendSwitchState.preferredBackend = selected;
      backendSwitchState.cloudFailureStreak = 0;
      backendSwitchState.cloudRecoveryStreak = 0;
      backendSwitchState.edgeFailureStreak = 0;
      backendSwitchState.edgeRecoveryStreak = 0;
      void switchDiarizationBackend(selected, "manual selection", {
        automatic: false,
        persist: true,
        skipCooldown: true
      }).catch((error) => {
        logLine(`Manual backend switch failed: ${error.message}`);
      });
    });
  }

  if (btnAttachTeams) {
    btnAttachTeams.addEventListener("click", async () => {
      try {
        const status = await requestAttachToTeams();
        logLine(`Attach requested: status=${status.status}`);
      } catch (error) {
        logLine(`Attach failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnDetachTeams) {
    btnDetachTeams.addEventListener("click", async () => {
      try {
        const status = await requestDetachFromTeams();
        logLine(`Detached from Teams: status=${status.status}`);
      } catch (error) {
        logLine(`Detach failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnOpenAccessibilitySettings) {
    btnOpenAccessibilitySettings.addEventListener("click", async () => {
      try {
        await desktopAPI.openPrivacySettings({ target: "accessibility" });
        logLine("Opened Accessibility settings.");
      } catch (error) {
        logLine(`Open Accessibility settings failed: ${error.message}`);
      }
    });
  }

  if (btnOpenAutomationSettings) {
    btnOpenAutomationSettings.addEventListener("click", async () => {
      try {
        await desktopAPI.openPrivacySettings({ target: "automation" });
        logLine("Opened Automation settings.");
      } catch (error) {
        logLine(`Open Automation settings failed: ${error.message}`);
      }
    });
  }

  if (btnDashboardAddMeeting) {
    btnDashboardAddMeeting.addEventListener("click", () => {
      try {
        addMeetingFromDashboardForm();
      } catch (error) {
        logLine(`Add dashboard meeting failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (dashboardMeetingListEl) {
    dashboardMeetingListEl.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const actionButton = target.closest("[data-meeting-action]");
      if (!actionButton) return;
      const action = String(actionButton.dataset.meetingAction || "");
      const meetingId = String(actionButton.dataset.meetingId || "");
      const meeting = dashboardMeetings.find((item) => String(item?.meeting_id || "") === meetingId);
      if (!meeting) return;

      if (action === "remove") {
        dashboardMeetings = dashboardMeetings.filter((item) => String(item?.meeting_id || "") !== meetingId);
        persistDashboardMeetings();
        renderMeetingList();
        logLine(`Dashboard meeting removed: ${meetingId}`);
        return;
      }

      if (action === "start") {
        applyMeetingToSession(meeting);
        if (meeting?.join_url) {
          await desktopAPI.openExternalUrl({ url: String(meeting.join_url) });
        }
        const status = await requestAttachToTeams();
        if (status?.status === "attached") {
          setAppMode("session");
        } else {
          setAppMode("session");
          setUploadStatus(`Waiting for Teams attach. status=${status?.status || "unknown"}`);
        }
        await refreshLiveView().catch(() => {
          // ignore initial fetch failures
        });
        return;
      }
    });
  }

  if (btnHistoryRefresh) {
    btnHistoryRefresh.addEventListener("click", async () => {
      try {
        await refreshSessionHistory({ limit: 20 });
        logLine("Session history refreshed.");
      } catch (error) {
        logLine(`Refresh session history failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (historyListEl) {
    historyListEl.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const buttonEl = target.closest("[data-history-action]");
      if (!buttonEl) return;
      const action = String(buttonEl.dataset.historyAction || "").trim();
      if (action === "more") {
        try {
          await refreshSessionHistory({ limit: 20, cursor: historyCursor || "", append: true });
        } catch (error) {
          logLine(`Load more history failed: ${error.message}`);
          setResultPayload({ error: error.message });
        }
        return;
      }
      const sessionId = String(buttonEl.dataset.sessionId || "").trim();
      if (!sessionId) return;
      if (action === "copy-session") {
        if (meetingIdEl) {
          meetingIdEl.value = sessionId;
        }
        logLine(`Session ID set from history: ${sessionId}`);
        return;
      }
      if (action === "open") {
        try {
          if (meetingIdEl) {
            meetingIdEl.value = sessionId;
          }
          const resultV2 = await desktopAPI.getResultV2({
            baseUrl: normalizeHttpBaseUrl(apiBaseUrlEl.value),
            sessionId
          });
          renderReportV2(resultV2);
          openReviewPanel("overall");
          setResultPayload(resultV2);
          setAppMode("session");
          logLine(`History report opened: ${sessionId}`);
        } catch (error) {
          logLine(`Open history report failed: ${error.message}`);
          setResultPayload({ error: error.message });
        }
      }
    });
  }

  if (btnDashboardEnterSession) {
    btnDashboardEnterSession.addEventListener("click", async () => {
      try {
        const status = await requestAttachToTeams();
        if (status?.status !== "attached") {
          throw new Error(`Teams attach required before session. status=${status?.status || "unknown"}`);
        }
        setAppMode("session");
      } catch (error) {
        logLine(`Open sidebar workspace failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnBackDashboard) {
    btnBackDashboard.addEventListener("click", async () => {
      try {
        await requestDetachFromTeams();
      } catch (error) {
        logLine(`Detach while returning dashboard failed: ${error.message}`);
      }
      setAppMode("dashboard");
    });
  }

  if (btnGraphSaveConfig) {
    btnGraphSaveConfig.addEventListener("click", async () => {
      try {
        await saveGraphConfig();
      } catch (error) {
        logLine(`Save Graph config failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnGraphConnect) {
    btnGraphConnect.addEventListener("click", async () => {
      try {
        await connectGraphCalendar();
      } catch (error) {
        logLine(`Graph connect failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnGraphSync) {
    btnGraphSync.addEventListener("click", async () => {
      try {
        await syncMeetingsFromGraph();
      } catch (error) {
        logLine(`Graph sync failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnGraphCreateMeeting) {
    btnGraphCreateMeeting.addEventListener("click", async () => {
      try {
        const meeting = await createMeetingWithGraph();
        applyMeetingToSession(meeting);
      } catch (error) {
        logLine(`Graph create meeting failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnGraphDisconnect) {
    btnGraphDisconnect.addEventListener("click", async () => {
      try {
        await disconnectGraphCalendar();
      } catch (error) {
        logLine(`Graph disconnect failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnToggleDebug) {
    btnToggleDebug.addEventListener("click", () => {
      toggleDebugDrawer();
    });
  }

  if (btnUiDensity) {
    btnUiDensity.addEventListener("click", () => {
      toggleUiDensity();
    });
  }

  for (const button of debugTabButtons) {
    button.addEventListener("click", () => {
      const tabName = String(button.dataset.debugTabBtn || "logs");
      switchDebugTab(tabName);
    });
  }

  if (btnOpenReview) {
    btnOpenReview.addEventListener("click", () => {
      openReviewPanel(currentReviewTab || "overall");
    });
  }
  if (btnFeedbackReady) {
    btnFeedbackReady.addEventListener("click", async () => {
      try {
        await checkFeedbackReady();
      } catch (error) {
        logLine(`Feedback-ready failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }
  if (btnOpenFeedback) {
    btnOpenFeedback.addEventListener("click", async () => {
      try {
        await openFeedbackReport();
      } catch (error) {
        logLine(`Open feedback failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }
  if (btnFeedbackExportText) {
    btnFeedbackExportText.addEventListener("click", async () => {
      try {
        await exportFeedback("plain_text");
      } catch (error) {
        logLine(`Export plain text failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }
  if (btnFeedbackExportMd) {
    btnFeedbackExportMd.addEventListener("click", async () => {
      try {
        await exportFeedback("markdown");
      } catch (error) {
        logLine(`Export markdown failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }
  if (btnFeedbackExportDocx) {
    btnFeedbackExportDocx.addEventListener("click", async () => {
      try {
        await exportFeedback("docx");
      } catch (error) {
        logLine(`Export docx failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }
  if (reviewTabOverallBtn) {
    reviewTabOverallBtn.addEventListener("click", () => openReviewPanel("overall"));
  }
  if (reviewTabPersonBtn) {
    reviewTabPersonBtn.addEventListener("click", () => openReviewPanel("person"));
  }
  if (reviewTabEvidenceBtn) {
    reviewTabEvidenceBtn.addEventListener("click", () => openReviewPanel("evidence"));
  }
  if (reviewPanelEl) {
    reviewPanelEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const chip = target.closest(".evidence-chip");
      if (!(chip instanceof HTMLElement)) return;
      handleEvidenceChipClick(chip);
    });
  }

  if (evidenceModalCloseEl) {
    evidenceModalCloseEl.addEventListener("click", () => {
      closeEvidenceModal();
    });
  }
  if (btnEvidenceModalClose) {
    btnEvidenceModalClose.addEventListener("click", () => {
      closeEvidenceModal();
    });
  }
  if (btnRegenerateClaim) {
    btnRegenerateClaim.addEventListener("click", async () => {
      try {
        await regenerateSelectedClaim();
        closeEvidenceModal();
      } catch (error) {
        logLine(`Regenerate claim failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }
  if (btnApplyClaimEvidence) {
    btnApplyClaimEvidence.addEventListener("click", async () => {
      try {
        await applySelectedClaimEvidenceRefs();
        closeEvidenceModal();
      } catch (error) {
        logLine(`Apply claim evidence failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

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

  if (btnEnrollmentStart) {
    btnEnrollmentStart.addEventListener("click", async () => {
      try {
        await startEnrollment();
        await refreshLiveView();
      } catch (error) {
        logLine(`Start enrollment failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnEnrollmentStop) {
    btnEnrollmentStop.addEventListener("click", async () => {
      try {
        await stopEnrollment();
        await refreshLiveView();
      } catch (error) {
        logLine(`Stop enrollment failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

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

  if (btnRefreshClusters) {
    btnRefreshClusters.addEventListener("click", async () => {
      try {
        await refreshUnresolvedClusters();
        logLine("Unresolved clusters refreshed.");
      } catch (error) {
        logLine(`Refresh unresolved clusters failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnMemoAdd) {
    btnMemoAdd.addEventListener("click", async () => {
      try {
        await addMemo();
      } catch (error) {
        logLine(`Add memo failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnMemoAnchorLast) {
    btnMemoAnchorLast.addEventListener("click", async () => {
      try {
        await anchorMemoToLastUtterance();
      } catch (error) {
        logLine(`Anchor memo failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnFinalizeV2) {
    btnFinalizeV2.addEventListener("click", async () => {
      try {
        await triggerFinalizeV2();
      } catch (error) {
        logLine(`Finalize v2 failed: ${error.message}`);
        setFinalizeStatus(`failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnSidecarStart) {
    btnSidecarStart.addEventListener("click", async () => {
      try {
        const status = await desktopAPI.diarizationStart({});
        if (sidecarStatusEl) {
          sidecarStatusEl.textContent = JSON.stringify(status, null, 2);
        }
        await refreshSidecarStatus();
        logLine("Sidecar started.");
      } catch (error) {
        sidecarActive = false;
        logLine(`Sidecar start failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (btnSidecarStop) {
    btnSidecarStop.addEventListener("click", async () => {
      try {
        const status = await desktopAPI.diarizationStop();
        sidecarActive = false;
        if (sidecarStatusEl) {
          sidecarStatusEl.textContent = JSON.stringify(status, null, 2);
        }
        if (effectiveDiarizationBackend() === "edge") {
          await switchDiarizationBackend("cloud", "manual sidecar stop", {
            automatic: true,
            persist: true,
            skipCooldown: true
          });
        }
        logLine("Sidecar stopped.");
      } catch (error) {
        logLine(`Sidecar stop failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  if (clusterMapListEl) {
    clusterMapListEl.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const buttonEl = target.closest(".cluster-map-apply");
      if (!buttonEl) return;
      try {
        await applyClusterMappingFromButton(buttonEl);
        await refreshLiveView();
      } catch (error) {
        logLine(`Apply cluster mapping failed: ${error.message}`);
        setResultPayload({ error: error.message });
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    const key = String(event.key || "").toLowerCase();
    const debugHotKey = key === "d" && event.shiftKey && (event.metaKey || event.ctrlKey);
    if (debugHotKey) {
      event.preventDefault();
      toggleDebugDrawer();
      return;
    }
    if (event.key === "Escape" && evidenceModalEl && !evidenceModalEl.classList.contains("hidden")) {
      closeEvidenceModal();
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    if (typeof desktopAPI.onDeepLinkStart === "function") {
      deepLinkUnsubscribe = desktopAPI.onDeepLinkStart((payload) => {
        handleDeepLinkStart(payload).catch((error) => {
          logLine(`Deep link handling failed: ${error.message}`);
          setResultPayload({ error: error.message });
        });
      });
    }
    loadDashboardState();
    initBackendSwitchState();
    applyUiDensity(uiDensity);
    renderMeetingList();
    if (participantRows().length === 0) {
      addParticipantRow();
    }
    setAppMode("dashboard");
    renderCaptureHealth();
    switchDebugTab("logs");
    toggleDebugDrawer(false);
    updateBackendBadge();
    updateButtons();
    await renderRuntimeInfo();
    bindEvents();
    if (btnRegenerateClaim) {
      btnRegenerateClaim.disabled = true;
    }
    if (btnApplyClaimEvidence) {
      btnApplyClaimEvidence.disabled = true;
    }
    if (graphClientIdEl?.value) {
      await desktopAPI.calendarSetConfig({
        clientId: String(graphClientIdEl.value || "").trim(),
        tenantId: String(graphTenantIdEl?.value || "common").trim() || "common"
      }).catch((error) => {
        logLine(`Graph bootstrap config failed: ${error.message}`);
      });
    }
    await refreshGraphStatus().catch(() => {
      // ignore startup graph status failures
    });
    await requestAttachToTeams().catch((error) => {
      logLine(`Attach on startup failed: ${error.message}`);
    });
    startAttachPolling();
    await refreshLiveView().catch(() => {
      // ignore startup fetch failures
    });
    await refreshMemos().catch(() => {
      // ignore startup memo fetch failures
    });
    await refreshSessionHistory({ limit: 20 }).catch((error) => {
      logLine(`Initial history load failed: ${error.message}`);
    });
    await refreshSidecarStatus();
  } catch (error) {
    const detail = error?.message || String(error);
    safeLogToConsole(`startup failed: ${detail}`);
    setResultPayload({ error: `startup failed: ${detail}` });
    logLine(`Startup failed: ${detail}`);
  }
});

window.addEventListener("beforeunload", () => {
  suppressAutoRecover = true;
  clearRecordingTimer();
  if (typeof deepLinkUnsubscribe === "function") {
    try {
      deepLinkUnsubscribe();
    } catch {
      // noop
    }
    deepLinkUnsubscribe = null;
  }

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
  if (finalizeV2PollTimer) {
    window.clearInterval(finalizeV2PollTimer);
    finalizeV2PollTimer = undefined;
  }
  stopAttachPolling();
  stopSessionTimer();
  stopLivePolling();

  desktopAPI.detachFromTeams().catch(() => {
    // noop
  });

  releaseMicStream();
  releaseSystemStream();

  if (audioContext) {
    audioContext.close();
  }

  if (playbackBlobUrl) {
    URL.revokeObjectURL(playbackBlobUrl);
  }
});
