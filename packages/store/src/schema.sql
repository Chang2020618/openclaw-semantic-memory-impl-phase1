-- OpenClaw Semantic Memory v0.1 — SQLite schema
--
-- This file is the canonical schema definition. The store applies it on
-- demand; running it twice is a no-op thanks to IF NOT EXISTS.
--
-- Hard rules (v0.1):
--   * markdown is the source of truth; this DB can be deleted at any time
--   * embedding model id is stored on every chunk; rankings never mix models
--   * archived memories are filtered out of default retrieval
--   * audit log is append-only

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- One row per Memory object.
CREATE TABLE IF NOT EXISTS memories (
  memory_id      TEXT PRIMARY KEY,
  memory_type    TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  timestamp      TEXT NOT NULL,
  importance     REAL NOT NULL,
  confidence     REAL NOT NULL,
  status         TEXT NOT NULL,
  source_kind    TEXT NOT NULL,
  scope          TEXT NOT NULL,
  project        TEXT,
  channel        TEXT,
  hash           TEXT NOT NULL,
  json           TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS memories_status_idx       ON memories(status);
CREATE INDEX IF NOT EXISTS memories_scope_idx        ON memories(scope);
CREATE INDEX IF NOT EXISTS memories_project_idx      ON memories(project);
CREATE INDEX IF NOT EXISTS memories_channel_idx      ON memories(channel);
CREATE INDEX IF NOT EXISTS memories_source_kind_idx  ON memories(source_kind);
CREATE INDEX IF NOT EXISTS memories_timestamp_idx    ON memories(timestamp);

-- One row per retrievable chunk. A Memory may produce multiple chunks.
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id           TEXT PRIMARY KEY,
  memory_id          TEXT NOT NULL,
  text               TEXT NOT NULL,
  source_path        TEXT NOT NULL,
  line_start         INTEGER,
  line_end           INTEGER,
  embedding_model_id TEXT NOT NULL,
  hash               TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (memory_id) REFERENCES memories(memory_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chunks_memory_idx        ON chunks(memory_id);
CREATE INDEX IF NOT EXISTS chunks_source_idx        ON chunks(source_path);
CREATE INDEX IF NOT EXISTS chunks_embedding_id_idx  ON chunks(embedding_model_id);

-- Append-only audit log.
CREATE TABLE IF NOT EXISTS audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_kind_idx ON audit(kind);
CREATE INDEX IF NOT EXISTS audit_ts_idx   ON audit(ts);

-- Index metadata: tracks which embedding model the index was last rebuilt
-- against. The retrieval layer refuses to mix models; switching dim requires
-- a versioned reindex (or migration).
CREATE TABLE IF NOT EXISTS index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The vec0 vector table is created at runtime once the embedding dimension
-- is known. We do NOT create chunk_vectors here because vec0 needs an
-- explicit dimension in its DDL.
--
-- Same for the FTS5 table; it has no dim concern but lives next to vec0
-- creation for symmetry. See store/sqlite.ts ensureSearchTables().

-- ============================================================
-- Phase-2: ephemeral memory layer (session summaries, etc.)
--
-- Hard rules:
--   * ephemeral memories ALWAYS have source_kind='assistant_inferred'
--   * ephemeral memories ALWAYS have a non-NULL expires_at
--   * ephemeral memories NEVER live in `memories` / `chunks` / `chunk_vectors`
--   * `osm index --rebuild` does NOT touch ephemeral_*
-- ============================================================

CREATE TABLE IF NOT EXISTS ephemeral_memories (
  memory_id    TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  memory_type  TEXT NOT NULL,
  summary      TEXT NOT NULL,
  importance   REAL NOT NULL,
  confidence   REAL NOT NULL,
  citation     TEXT NOT NULL,
  source_kind  TEXT NOT NULL CHECK(source_kind = 'assistant_inferred'),
  scope        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  raw_excerpt  TEXT,
  hash         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  json         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ephemeral_memories_session_idx ON ephemeral_memories(session_id);
CREATE INDEX IF NOT EXISTS ephemeral_memories_expires_idx ON ephemeral_memories(expires_at);
CREATE INDEX IF NOT EXISTS ephemeral_memories_status_idx  ON ephemeral_memories(status);

CREATE TABLE IF NOT EXISTS ephemeral_chunks (
  chunk_id           TEXT PRIMARY KEY,
  memory_id          TEXT NOT NULL,
  text               TEXT NOT NULL,
  embedding_model_id TEXT NOT NULL,
  hash               TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at         TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES ephemeral_memories(memory_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ephemeral_chunks_memory_idx  ON ephemeral_chunks(memory_id);
CREATE INDEX IF NOT EXISTS ephemeral_chunks_expires_idx ON ephemeral_chunks(expires_at);
CREATE INDEX IF NOT EXISTS ephemeral_chunks_embedding_idx ON ephemeral_chunks(embedding_model_id);

-- ============================================================
-- Task tracking MVP (task flow / runtime timeline / approvals)
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  goal           TEXT NOT NULL,
  status         TEXT NOT NULL,
  parent_task_id TEXT,
  root_task_id   TEXT NOT NULL,
  session_key    TEXT,
  owner_type     TEXT NOT NULL,
  owner_id       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  started_at     TEXT,
  ended_at       TEXT,
  result_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_root_task_id ON tasks(root_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session_key ON tasks(session_key);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS task_runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  status        TEXT NOT NULL,
  session_key   TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  error_message TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);

CREATE TABLE IF NOT EXISTS runtime_events (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  task_run_id  TEXT,
  session_key  TEXT,
  type         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  payload_json TEXT,
  ts           TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_task_id_ts ON runtime_events(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_runtime_events_session_key ON runtime_events(session_key);

CREATE TABLE IF NOT EXISTS approval_requests (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  task_run_id  TEXT,
  session_key  TEXT,
  action_type  TEXT NOT NULL,
  target       TEXT NOT NULL,
  reason       TEXT NOT NULL,
  risk_level   TEXT NOT NULL,
  status       TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at   TEXT,
  decided_by   TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_task_id ON approval_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
