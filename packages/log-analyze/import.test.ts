import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adaptDatabase, importSessionFile, openLogDb } from "./import.ts";

describe("adaptDatabase", () => {
	it("adapts a prepare-only Node SQLite style driver", () => {
		const calls: string[] = [];
		const raw = {
			exec(sql: string) { calls.push(sql); },
			prepare(sql: string) {
				calls.push(`prepare:${sql}`);
				return {
					run(...params: unknown[]) { return { changes: params.length }; },
					get() { return { value: 1 }; },
					all() { return [{ value: 1 }]; },
				};
			},
			close() { calls.push("close"); },
		};

		const db = adaptDatabase(raw);
		expect(db.query("SELECT 1").all()).toEqual([{ value: 1 }]);
		expect(db.run("UPDATE t SET value = ?", 2)).toEqual({ changes: 1 });
		db.transaction(() => calls.push("work"))();

		expect(calls).toEqual([
			"prepare:SELECT 1",
			"prepare:UPDATE t SET value = ?",
			"BEGIN",
			"work",
			"COMMIT",
		]);
	});

	it("rolls back a fallback transaction when work fails", () => {
		const calls: string[] = [];
		const db = adaptDatabase({
			exec(sql: string) { calls.push(sql); },
			prepare() { return { run() {}, get() {}, all() { return []; } }; },
			close() {},
		});

		expect(() => db.transaction(() => { throw new Error("boom"); })()).toThrow("boom");
		expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
	});
});

describe("importSessionFile", () => {
	it("uses original line offsets for fallback IDs after malformed JSONL rows", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-oh-my-log-"));
		const sessionFile = join(dir, "session.jsonl");
		const db = openLogDb(":memory:");
		try {
			expect(db).not.toBeNull();
			writeFileSync(sessionFile, [
				JSON.stringify({ type: "message", message: { role: "user", content: "first" } }),
				"not json",
				JSON.stringify({ type: "message", message: { role: "user", content: "second" } }),
			].join("\n"));

			expect(importSessionFile(db, sessionFile)).toBe(2);
			const ids = db!.query("SELECT id FROM messages ORDER BY id").all().map((row) => (row as { id: string }).id);
			expect(ids).toEqual(["session.jsonl#0", "session.jsonl#2"]);
		} finally {
			db?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
