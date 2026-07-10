/**
 * Incremental JSONL → SQLite importer.
 *
 * Reads session .jsonl files and inserts all rows into the messages + tool_calls tables.
 * Tracks per-file line offset in import_state so repeated calls only process new lines.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureSchema, extractTextPreview } from "./db.ts";

const HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";
export const SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");
export const DB_PATH = join(HOME, ".pi", "agent", "log.db");

type Database = {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  query(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  run(sql: string, ...params: unknown[]): { changes?: number };
  close(): void;
  transaction(fn: () => void): () => void;
};

let DatabaseCtor: { new (path: string): Database } | null = null;
try {
  // Bun runtime
  const mod = await import("bun:sqlite");
  DatabaseCtor = mod.Database;
} catch {
  try {
    // Node runtime with better-sqlite3
    const mod = await import("better-sqlite3");
    DatabaseCtor = mod.default ?? mod.Database;
  } catch {
    // No SQLite available — log-analyze will be disabled
  }
}

interface ImportState {
  lines_imported: number;
}

interface SessionJsonlEntry {
  type?: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  customType?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    provider?: string;
    api?: string;
    stopReason?: string;
    errorMessage?: string;
    responseId?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      reasoning?: number;
    };
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    timestamp?: number;
  };
  data?: unknown;
}

/**
 * Import new lines from a single session file into the database.
 * Returns the number of newly imported rows.
 */
export function importSessionFile(db: Database | null, sessionFile: string): number {
  if (!db) return 0;
  if (!existsSync(sessionFile)) return 0;

  const state = db
    .query("SELECT lines_imported FROM import_state WHERE session_file = ?")
    .get(sessionFile) as ImportState | undefined;

  const startLine = state?.lines_imported ?? 0;

  let content: string;
  try {
    content = readFileSync(sessionFile, "utf-8");
  } catch {
    return 0;
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (startLine >= lines.length) return 0;

  const newLines = lines.slice(startLine);
  const sessionId = sessionFile.split("/").pop() ?? sessionFile;

  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, session_id, parent_id, timestamp, ts, type, role,
       model, provider, api, stop_reason, error_message, response_id,
       input_tokens, output_tokens, cache_read, cache_write, total_tokens, reasoning_tokens,
       tool_name, tool_call_id, is_error,
       text_preview, content_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertCall = db.prepare(`
    INSERT OR IGNORE INTO tool_calls
      (id, session_id, timestamp, ts, tool_name, arguments)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;

  db.transaction(() => {
    for (const line of newLines) {
      let d: SessionJsonlEntry;
      try {
        d = JSON.parse(line) as SessionJsonlEntry;
      } catch {
        continue;
      }

      const msg = d.message;
      const ts = d.timestamp ? Date.parse(d.timestamp) : (msg?.timestamp ?? 0);

      // Generate a stable ID if not present
      const id = d.id ?? `${sessionId}#${startLine + imported}`;
      const role = msg?.role ?? (d.type === "custom" ? "custom" : "unknown");
      const contentJson = JSON.stringify(msg?.content ?? d.data ?? null);
      const textPreview = extractTextPreview(msg?.content ?? d.data);
      const isError = msg?.isError ? 1 : 0;
      const usage = msg?.usage;

      insertMsg.run(
        id,
        sessionId,
        d.parentId ?? null,
        d.timestamp ?? null,
        ts,
        d.type ?? "message",
        role,
        msg?.model ?? null,
        msg?.provider ?? null,
        msg?.api ?? null,
        msg?.stopReason ?? null,
        msg?.errorMessage ?? null,
        msg?.responseId ?? null,
        usage?.input ?? null,
        usage?.output ?? null,
        usage?.cacheRead ?? null,
        usage?.cacheWrite ?? null,
        usage?.totalTokens ?? null,
        usage?.reasoning ?? null,
        msg?.toolName ?? null,
        msg?.toolCallId ?? null,
        isError,
        textPreview,
        contentJson,
      );

      // If assistant message has tool calls, insert them into tool_calls
      if (Array.isArray(msg?.content)) {
        for (const c of msg!.content!) {
          if (!c || typeof c !== "object") continue;
          const obj = c as Record<string, unknown>;
          if (obj.type === "toolCall" && typeof obj.id === "string") {
            insertCall.run(
              obj.id,
              sessionId,
              d.timestamp ?? null,
              ts,
              (obj.name as string) ?? null,
              JSON.stringify(obj.arguments ?? {}),
            );
          }
        }
      }

      imported++;
    }

    // Update offset
    db.query("INSERT OR REPLACE INTO import_state (session_file, lines_imported, last_imported_ts) VALUES (?, ?, ?)").run(
      sessionFile,
      lines.length,
      new Date().toISOString(),
    );
  })();

  return imported;
}

/**
 * Import all session files under SESSIONS_DIR.
 * Returns total imported rows.
 */
export function importAllSessions(db: Database | null, dir: string = SESSIONS_DIR): number {
  if (!db) return 0;
  ensureSchema(db as any);

  if (!existsSync(dir)) return 0;

  let total = 0;
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".jsonl")) {
        const n = importSessionFile(db, full);
        total += n;
      }
    }
  }

  walk(dir);
  return total;
}

/**
 * Open (or create) the log database.
 * Returns null if no SQLite runtime is available (e.g. node without better-sqlite3).
 */
export function openLogDb(path: string = DB_PATH): Database | null {
  if (!DatabaseCtor) return null;
  const db = new DatabaseCtor(path);
  ensureSchema(db as any);
  return db as any;
}
