/**
 * pi-oh-my-log-analyze: SQLite-backed session log analysis.
 *
 * How it works:
 * 1. On session_start: open the SQLite DB, ensure schema.
 * 2. On agent_end: incrementally import new lines from the current session file.
 * 3. On session_shutdown: final flush + close DB.
 * 4. /log <sql>   — run a SQL query and show results in TUI.
 * 5. /log-stats   — show daily/model/tool summary tables.
 * 6. /log-import  — full re-import of all historical sessions.
 *
 * The DB lives at ~/.pi/agent/log.db (WAL mode, safe for concurrent reads).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Database } from "bun:sqlite";
import { ensureSchema, extractTextPreview } from "./db.ts";
import {
  importSessionFile,
  importAllSessions,
  openLogDb,
  DB_PATH,
  SESSIONS_DIR,
} from "./import.ts";

const MAX_DISPLAY_ROWS = 50;
const MAX_CELL_WIDTH = 120;

let db: Database | null = null;
let currentSessionFile: string | null = null;

function getDb(): Database {
  if (!db) {
    db = openLogDb();
  } else {
    ensureSchema(db);
  }
  return db;
}

function formatTable(rows: Record<string, unknown>[]): string[] {
  if (rows.length === 0) return ["(no rows)"];

  const columns = Object.keys(rows[0]!);
  // Calculate column widths
  const widths = columns.map((col) => {
    const maxVal = Math.max(
      col.length,
      ...rows.map((r) => {
        const v = r[col];
        const s = v === null || v === undefined ? "NULL" : String(v);
        return s.length;
      }),
    );
    return Math.min(maxVal, MAX_CELL_WIDTH);
  });

  // Header
  const header = columns.map((c, i) => c.padEnd(widths[i]!)).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  // Rows
  const lines = [header, separator];
  for (const row of rows) {
    const cells = columns.map((c, i) => {
      const v = row[c];
      let s = v === null || v === undefined ? "NULL" : String(v);
      if (s.length > MAX_CELL_WIDTH) s = s.slice(0, MAX_CELL_WIDTH - 3) + "...";
      return s.padEnd(widths[i]!);
    });
    lines.push(cells.join(" | "));
  }

  if (rows.length > MAX_DISPLAY_ROWS) {
    lines.push(`... ${rows.length - MAX_DISPLAY_ROWS} more rows (use LIMIT)`);
  }

  return lines;
}

function runQuery(ctx: ExtensionCommandContext, sql: string): void {
  const database = getDb();
  try {
    const trimmed = sql.trim().toLowerCase();
    const isSelect =
      trimmed.startsWith("select") ||
      trimmed.startsWith("with") ||
      trimmed.startsWith("pragma");

    if (isSelect) {
      const rows = database.query(sql).all() as Record<string, unknown>[];
      const display = formatTable(rows.slice(0, MAX_DISPLAY_ROWS));
      ctx.ui.notify(display.join("\n"), "info");
    } else {
      const result = database.run(sql);
      ctx.ui.notify(
        `OK. ${result.changes ?? 0} rows affected.`,
        "info",
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.ui.notify(`SQL error: ${msg}`, "error");
  }
}

function showStats(ctx: ExtensionCommandContext): void {
  const database = getDb();

  const views: Array<{ label: string; sql: string }> = [
    { label: "Daily Stats", sql: "SELECT * FROM v_daily_stats" },
    { label: "Model Stats", sql: "SELECT * FROM v_model_stats" },
    { label: "Tool Stats", sql: "SELECT * FROM v_tool_stats" },
  ];

  const lines: string[] = [];
  for (const v of views) {
    try {
      const rows = database.query(v.sql).all() as Record<string, unknown>[];
      lines.push(`━━━ ${v.label} ━━━`);
      lines.push(...formatTable(rows));
      lines.push("");
    } catch (e) {
      lines.push(`━━━ ${v.label} ━━━`);
      lines.push(`Error: ${e instanceof Error ? e.message : String(e)}`);
      lines.push("");
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

function doFullImport(ctx: ExtensionCommandContext): void {
  ctx.ui.setStatus("log-import", "Importing all sessions...");
  const database = getDb();
  const total = importAllSessions(database);

  // Quick stats after import
  const stats = database
    .query("SELECT COUNT(*) as total_messages, SUM(is_error) as tool_errors, SUM(CASE WHEN stop_reason='error' THEN 1 ELSE 0 END) as api_errors FROM messages")
    .get() as Record<string, number> | undefined;

  ctx.ui.setStatus("log-import", undefined);
  ctx.ui.notify(
    `Imported ${total} new rows.\n` +
      `DB total: ${stats?.total_messages ?? 0} messages, ` +
      `${stats?.api_errors ?? 0} API errors, ` +
      `${stats?.tool_errors ?? 0} tool errors.\n` +
      `DB path: ${DB_PATH}`,
    "info",
  );
}

export default function logAnalyze(pi: ExtensionAPI): void {
  // ── session_start: open DB, find current session file ──────────
  pi.on("session_start", (_e, ctx) => {
    getDb(); // ensure DB is open
    // The session file may not exist yet on a brand-new session;
    // we'll pick it up on agent_end instead.
    try {
      const sf = ctx.sessionManager.getSessionFile();
      if (sf) {
        currentSessionFile = sf;
        // Import any existing lines (e.g., resumed session)
        importSessionFile(db!, sf);
      }
    } catch {}
  });

  // ── agent_end: incremental import of new session lines ─────────
  pi.on("agent_end", (_e, ctx) => {
    try {
      const sf = ctx.sessionManager.getSessionFile() ?? currentSessionFile;
      if (sf) {
        currentSessionFile = sf;
        importSessionFile(db!, sf);
      }
    } catch {}
  });

  // ── session_shutdown: final flush + close ──────────────────────
  pi.on("session_shutdown", () => {
    try {
      if (currentSessionFile && db) {
        importSessionFile(db, currentSessionFile);
      }
    } catch {}
    // Don't close the DB — it might be used by /log command
    // after shutdown (reload case). It will be reopened on next session_start.
  });

  // ── /log <sql> — run SQL query ─────────────────────────────────
  pi.registerCommand("log", {
    description: "Query session logs via SQL. Usage: /log SELECT * FROM v_daily_stats",
    handler: async (args, ctx) => {
      const sql = args.trim();
      if (!sql) {
        ctx.ui.notify(
          [
            "Usage: /log <sql>",
            "",
            "Examples:",
            "  /log SELECT * FROM v_daily_stats",
            "  /log SELECT * FROM v_api_errors WHERE date(timestamp)='2026-07-09'",
            "  /log SELECT * FROM v_tool_stats",
            "  /log SELECT * FROM v_model_stats",
            "  /log SELECT * FROM v_tool_errors LIMIT 20",
            "",
            "Views: v_daily_stats, v_api_errors, v_tool_errors, v_model_stats, v_tool_stats",
            `DB: ${DB_PATH}`,
          ].join("\n"),
          "info",
        );
        return;
      }
      runQuery(ctx, sql);
    },
  });

  // ── /log-stats — show summary tables ──────────────────────────
  pi.registerCommand("log-stats", {
    description: "Show session log summary statistics (daily, model, tool)",
    handler: async (_args, ctx) => {
      showStats(ctx);
    },
  });

  // ── /log-import — full re-import of all sessions ───────────────
  pi.registerCommand("log-import", {
    description: "Import all historical session files into SQLite (full rebuild)",
    handler: async (_args, ctx) => {
      doFullImport(ctx);
    },
  });
}
