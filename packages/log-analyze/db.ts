/**
 * SQLite schema + database helpers for session log analysis.
 *
 * Two tables:
 *   messages    — every message/event (user, assistant, toolResult, custom)
 *   tool_calls  — tool call invocations (for joining with toolResult messages)
 *
 * Plus an import_state table for incremental sync (tracks per-file line offset).
 */

// Minimal Database interface — works with both bun:sqlite and better-sqlite3
export interface LogDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  query(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  run(sql: string, ...params: unknown[]): { changes?: number };
  close(): void;
  transaction(fn: () => void): () => void;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  parent_id     TEXT,
  timestamp     TEXT,
  ts            INTEGER,
  type          TEXT,
  role          TEXT,

  -- API layer (assistant messages)
  model         TEXT,
  provider      TEXT,
  api           TEXT,
  stop_reason   TEXT,
  error_message TEXT,
  response_id   TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cache_read    INTEGER,
  cache_write   INTEGER,
  total_tokens  INTEGER,
  reasoning_tokens INTEGER,

  -- Tool layer (toolResult messages)
  tool_name     TEXT,
  tool_call_id  TEXT,
  is_error      INTEGER DEFAULT 0,

  -- Content
  text_preview  TEXT,
  content_json  TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  timestamp     TEXT,
  ts            INTEGER,
  tool_name     TEXT,
  arguments     TEXT
);

CREATE TABLE IF NOT EXISTS import_state (
  session_file  TEXT PRIMARY KEY,
  lines_imported INTEGER NOT NULL DEFAULT 0,
  last_imported_ts TEXT
);

CREATE INDEX IF NOT EXISTS idx_msg_ts        ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_msg_session   ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_msg_stop      ON messages(stop_reason);
CREATE INDEX IF NOT EXISTS idx_msg_error     ON messages(is_error);
CREATE INDEX IF NOT EXISTS idx_msg_tool       ON messages(tool_name);
CREATE INDEX IF NOT EXISTS idx_msg_model      ON messages(model);
CREATE INDEX IF NOT EXISTS idx_tc_session     ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tc_tool        ON tool_calls(tool_name);

-- ── Views ──────────────────────────────────────────────────

CREATE VIEW IF NOT EXISTS v_api_errors AS
  SELECT session_id, timestamp, model, provider,
         error_message, total_tokens, stop_reason
  FROM messages
  WHERE stop_reason = 'error'
  ORDER BY ts;

CREATE VIEW IF NOT EXISTS v_tool_errors AS
  SELECT m.session_id, m.timestamp, m.tool_name,
         m.text_preview AS error_text,
         tc.arguments   AS tool_args
  FROM messages m
  LEFT JOIN tool_calls tc ON m.tool_call_id = tc.id
  WHERE m.is_error = 1
  ORDER BY m.ts;

CREATE VIEW IF NOT EXISTS v_daily_stats AS
  SELECT date(timestamp) AS day,
         COUNT(*)                                    AS messages,
         SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END)  AS api_errors,
         SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END)          AS tool_errors,
         SUM(total_tokens)                            AS tokens,
         COUNT(DISTINCT session_id)                   AS sessions
  FROM messages
  GROUP BY day
  ORDER BY day;

CREATE VIEW IF NOT EXISTS v_model_stats AS
  SELECT model,
         COUNT(*)                                    AS messages,
         SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END)  AS api_errors,
         SUM(total_tokens)                            AS tokens
  FROM messages
  WHERE role = 'assistant'
  GROUP BY model
  ORDER BY messages DESC;

CREATE VIEW IF NOT EXISTS v_tool_stats AS
  SELECT tool_name,
         COUNT(*)                                    AS calls,
         SUM(is_error)                               AS errors,
         ROUND(100.0 * SUM(is_error) / COUNT(*), 1)  AS error_pct
  FROM messages
  WHERE role = 'toolResult'
  GROUP BY tool_name
  ORDER BY calls DESC;
`;

export function ensureSchema(db: LogDatabase): void {
  db.exec(SCHEMA);
}

/** Extract text content preview from a message's content field. */
export function extractTextPreview(content: unknown, maxLen = 500): string {
  if (typeof content === "string") return content.slice(0, maxLen);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") {
      parts.push(obj.text);
    }
  }
  return parts.join("\n").slice(0, maxLen);
}
