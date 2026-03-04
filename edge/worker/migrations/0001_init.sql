-- ============================================================================
-- Chorus D1 Schema — Session metadata index + structured queries
-- ============================================================================
-- D1 stores lightweight metadata; R2 stores full result JSON + audio blobs.
-- Run: npx wrangler d1 execute chorus-meta --file=migrations/0001_init.sql
-- ============================================================================

-- ── Organizations ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizations (
  id         TEXT PRIMARY KEY,          -- UUID
  name       TEXT NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'free',  -- free | pro | enterprise
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Users ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,          -- UUID
  email      TEXT UNIQUE NOT NULL,
  name       TEXT,
  org_id     TEXT REFERENCES organizations(id),
  role       TEXT NOT NULL DEFAULT 'member',  -- admin | member | viewer
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ── Sessions (core metadata index for R2 results) ──────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,     -- matches DO session_id
  org_id          TEXT REFERENCES organizations(id),
  created_by      TEXT REFERENCES users(id),
  title           TEXT,
  duration_ms     INTEGER,
  speaker_count   INTEGER,
  phase           TEXT NOT NULL DEFAULT 'idle',  -- idle|recording|finalizing|finalized|archived
  locale          TEXT DEFAULT 'zh-CN',
  r2_result_key   TEXT,                -- R2 object key for full result JSON
  r2_audio_key    TEXT,                -- R2 object key for audio
  score_avg       REAL,                -- average dimension score (for sorting)
  report_source   TEXT,                -- memo_first | llm_synthesized | etc.
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at    TEXT,
  archived_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_phase ON sessions(phase);

-- ── Dimension Scores (per-person per-session, for cross-session analytics) ─

CREATE TABLE IF NOT EXISTS dimension_scores (
  id          TEXT PRIMARY KEY,         -- UUID
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  person_key  TEXT NOT NULL,
  person_name TEXT,
  dimension   TEXT NOT NULL,
  label_zh    TEXT,
  score       REAL NOT NULL,            -- 0-10
  evidence_count INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scores_session ON dimension_scores(session_id);
CREATE INDEX IF NOT EXISTS idx_scores_person ON dimension_scores(person_key);
CREATE INDEX IF NOT EXISTS idx_scores_dimension ON dimension_scores(dimension);

-- ── Rubric Templates (reusable evaluation dimensions) ──────────────────────

CREATE TABLE IF NOT EXISTS rubric_templates (
  id             TEXT PRIMARY KEY,      -- UUID
  org_id         TEXT REFERENCES organizations(id),
  name           TEXT NOT NULL,
  interview_type TEXT,                  -- academic | technical | behavioral | group
  dimensions     TEXT NOT NULL,         -- JSON array of DimensionPresetItem[]
  is_default     INTEGER DEFAULT 0,     -- boolean: 1 = org default
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rubrics_org ON rubric_templates(org_id);

-- ── GDPR Audit Log ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gdpr_audit_log (
  id          TEXT PRIMARY KEY,         -- UUID
  user_id     TEXT REFERENCES users(id),
  action      TEXT NOT NULL,            -- consent_granted | data_deleted | export_requested
  session_id  TEXT,
  details     TEXT,                     -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gdpr_user ON gdpr_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_gdpr_action ON gdpr_audit_log(action);
