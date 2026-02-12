(function initLiveMetrics(global) {
  "use strict";

  const SUPPORT_PATTERNS = [
    /\bi agree\b/i,
    /\bi support\b/i,
    /\bbuilding on\b/i,
    /\bas .* said\b/i,
    /\bto add\b/i,
    /我同意/,
    /补充/,
    /在.+基础上/,
    /承接.*观点/
  ];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function cleanName(value) {
    return String(value || "").trim();
  }

  function mapSpeaker(item, eventIndex, fallbackRole, interviewerName) {
    const utteranceId = cleanName(item?.utterance_id);
    const event = utteranceId ? eventIndex.get(utteranceId) : null;
    if (cleanName(event?.speaker_name)) {
      return cleanName(event.speaker_name);
    }
    if (cleanName(event?.cluster_id)) {
      return `cluster:${cleanName(event.cluster_id)}`;
    }
    if (fallbackRole === "teacher") {
      return interviewerName || "Interviewer";
    }
    return "unknown";
  }

  function buildEventIndex(events) {
    const index = new Map();
    for (const item of events || []) {
      const utteranceId = cleanName(item?.utterance_id);
      if (!utteranceId) continue;
      index.set(utteranceId, item);
    }
    return index;
  }

  function buildKnownParticipants(options) {
    const names = new Set();
    const roster = Array.isArray(options?.roster) ? options.roster : [];
    for (const entry of roster) {
      const name = cleanName(entry?.name);
      if (name) names.add(name);
    }
    const uiParticipants = Array.isArray(options?.uiParticipants) ? options.uiParticipants : [];
    for (const entry of uiParticipants) {
      const name = cleanName(entry?.name || entry);
      if (name) names.add(name);
    }
    const interviewerName = cleanName(options?.interviewerName);
    if (interviewerName) names.add(interviewerName);
    return names;
  }

  function containsSupportCue(text) {
    const sample = String(text || "");
    return SUPPORT_PATTERNS.some((pattern) => pattern.test(sample));
  }

  function computeParticipantMetrics(options) {
    const eventIndex = buildEventIndex(options?.events || []);
    const interviewerName = cleanName(options?.interviewerName);
    const known = buildKnownParticipants(options);
    const utterances = [];
    for (const item of options?.teacherUtterances || []) {
      utterances.push({ ...item, stream_role: "teacher" });
    }
    for (const item of options?.studentsUtterances || []) {
      utterances.push({ ...item, stream_role: "students" });
    }

    utterances.sort((a, b) => {
      const aStart = Number(a?.start_ms || 0);
      const bStart = Number(b?.start_ms || 0);
      if (aStart !== bStart) return aStart - bStart;
      return Number(a?.end_ms || 0) - Number(b?.end_ms || 0);
    });

    const bySpeaker = new Map();

    function ensureSpeaker(name) {
      const key = cleanName(name) || "unknown";
      if (!bySpeaker.has(key)) {
        bySpeaker.set(key, {
          person_key: key,
          display_name: key,
          speaking_now: false,
          talk_time_ms: 0,
          turns: 0,
          support_count: 0,
          interruptions: 0,
          last_end_ms: 0
        });
      }
      return bySpeaker.get(key);
    }

    for (const knownName of known) {
      ensureSpeaker(knownName);
    }

    let totalTalkMs = 0;
    let totalTurns = 0;
    let totalSupport = 0;
    let timelineNowMs = Number(options?.timelineNowMs || 0);
    let previous = null;

    for (const utterance of utterances) {
      const speaker = mapSpeaker(utterance, eventIndex, utterance.stream_role, interviewerName);
      const entry = ensureSpeaker(speaker);
      const startMs = Number(utterance?.start_ms || 0);
      const endMs = Number(utterance?.end_ms || startMs);
      const duration = Math.max(0, endMs - startMs);
      entry.talk_time_ms += duration;
      entry.turns += 1;
      entry.last_end_ms = Math.max(entry.last_end_ms, endMs);
      totalTalkMs += duration;
      totalTurns += 1;

      if (containsSupportCue(utterance?.text)) {
        entry.support_count += 1;
        totalSupport += 1;
      }

      if (previous) {
        const prevSpeaker = mapSpeaker(previous, eventIndex, previous.stream_role, interviewerName);
        if (prevSpeaker !== speaker) {
          const overlapMs = Number(previous?.end_ms || 0) - startMs;
          if (overlapMs > 300 || overlapMs > 100) {
            entry.interruptions += 1;
          }
        }
      }
      previous = utterance;
      timelineNowMs = Math.max(timelineNowMs, endMs);
    }

    const rows = Array.from(bySpeaker.values()).map((entry) => {
      const talkShare = totalTalkMs > 0 ? entry.talk_time_ms / totalTalkMs : 0;
      const turnShare = totalTurns > 0 ? entry.turns / totalTurns : 0;
      const supportRate = Math.min(entry.support_count / 5, 1);
      const interruptRate = Math.min(entry.interruptions / 5, 1);
      const engagement_score = Math.round(
        clamp(talkShare * 55 + turnShare * 20 + supportRate * 20 - interruptRate * 15, 0, 100)
      );

      return {
        ...entry,
        speaking_now: timelineNowMs - entry.last_end_ms <= 2500,
        talk_share: talkShare,
        turn_share: turnShare,
        support_rate: supportRate,
        interrupt_rate: interruptRate,
        engagement_score
      };
    });

    rows.sort((a, b) => {
      if (b.engagement_score !== a.engagement_score) return b.engagement_score - a.engagement_score;
      if (b.talk_time_ms !== a.talk_time_ms) return b.talk_time_ms - a.talk_time_ms;
      return a.display_name.localeCompare(b.display_name);
    });

    return {
      participants: rows,
      totals: {
        total_talk_time_ms: totalTalkMs,
        total_turns: totalTurns,
        total_support: totalSupport,
        timeline_now_ms: timelineNowMs
      }
    };
  }

  global.IFLiveMetrics = {
    computeParticipantMetrics
  };
})(window);
