(function initTranscriptFormatter(global) {
  "use strict";

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatClock(ms) {
    const safeMs = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
    const totalSec = Math.floor(safeMs / 1000);
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${pad2(minutes)}:${pad2(seconds)}`;
  }

  function summarizeSpeaker(item, eventIndex, fallbackRole) {
    const utteranceId = String(item?.utterance_id || "").trim();
    const event = utteranceId ? eventIndex.get(utteranceId) : null;
    if (event?.speaker_name) {
      return event.speaker_name;
    }
    if (event?.cluster_id) {
      return `cluster:${event.cluster_id}`;
    }
    if (fallbackRole === "teacher") {
      return "Interviewer";
    }
    return "unknown";
  }

  function compactText(value, maxLength) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1)}…`;
  }

  function buildEventIndex(events) {
    const index = new Map();
    for (const item of events || []) {
      const utteranceId = String(item?.utterance_id || "").trim();
      if (!utteranceId) continue;
      index.set(utteranceId, item);
    }
    return index;
  }

  function formatUtterancesByRole(options) {
    const role = String(options?.role || "students");
    const title = String(options?.title || role);
    const response = options?.response || {};
    const items = Array.isArray(response.items) ? response.items : [];
    const eventIndex = options?.eventIndex instanceof Map ? options.eventIndex : new Map();
    const lines = [`${title} (count=${Number(response.count || items.length)})`];

    for (const item of items.slice(-30)) {
      const speaker = summarizeSpeaker(item, eventIndex, role);
      const when = formatClock(Number(item?.start_ms || 0));
      const text = compactText(item?.text, 280);
      lines.push(`[${when}] [${role}] [${speaker}] ${text}`);
    }

    return lines.join("\n");
  }

  function isoToClock(value) {
    const date = new Date(String(value || ""));
    if (Number.isNaN(date.getTime())) return "--:--";
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  function formatEvents(response) {
    const items = Array.isArray(response?.items) ? response.items : [];
    const lines = [`events count=${Number(response?.count || items.length)}`];
    for (const item of items.slice(-80)) {
      const speaker = item?.speaker_name || (item?.cluster_id ? `cluster:${item.cluster_id}` : "unknown");
      const source = item?.identity_source ? `${item.source}/${item.identity_source}` : String(item?.source || "unknown");
      const decision = String(item?.decision || "n/a");
      lines.push(`[${isoToClock(item?.ts)}] ${source} -> ${decision} -> ${speaker}`);
    }
    return lines.join("\n");
  }

  global.IFTranscriptFormatter = {
    formatClock,
    buildEventIndex,
    formatUtterancesByRole,
    formatEvents
  };
})(window);
