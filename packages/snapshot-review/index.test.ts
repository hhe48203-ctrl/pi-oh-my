import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectReviewSnapshot, MAX_REVIEW_PATCH_CHARS, prepareReviewArguments, type GitRunner } from "./index.ts";

let repo: string;
let runGit: GitRunner;

function git(...args: string[]): void {
	execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "pi-oh-my-review-"));
	git("init", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test User");
	runGit = async (args, cwd) => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			code: result.status ?? 1,
			killed: result.signal !== null,
		};
	};
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("collectReviewSnapshot", () => {
	it("includes tracked and untracked working-tree changes", async () => {
		writeFileSync(join(repo, "tracked.ts"), "export const value = 1;\n");
		git("add", "tracked.ts");
		git("commit", "-m", "initial");
		writeFileSync(join(repo, "tracked.ts"), "export const value = 2;\n");
		writeFileSync(join(repo, "new.ts"), "export const added = true;\n");

		const snapshot = await collectReviewSnapshot(repo, {}, runGit);

		expect(snapshot.patch).toContain("-export const value = 1;");
		expect(snapshot.patch).toContain("+export const value = 2;");
		expect(snapshot.patch).toContain("diff --untracked new.ts");
		expect(snapshot.patch).toContain("export const added = true;");
		expect(snapshot.untrackedFiles).toBe(1);
	});

	it("excludes unrelated working-tree edits from base review", async () => {
		writeFileSync(join(repo, "value.ts"), "export const value = 1;\n");
		git("add", "value.ts");
		git("commit", "-m", "initial");
		git("switch", "-c", "feature");
		writeFileSync(join(repo, "value.ts"), "export const value = 2;\n");
		git("add", "value.ts");
		git("commit", "-m", "feature change");
		writeFileSync(join(repo, "value.ts"), "export const value = 999;\n");

		const snapshot = await collectReviewSnapshot(repo, { base: "main" }, runGit);

		expect(snapshot.patch).toContain("+export const value = 2;");
		expect(snapshot.patch).not.toContain("999");
		expect(snapshot.label).toBe("main...HEAD committed changes");
	});

	it("rejects snapshots that would crowd the model context", async () => {
		writeFileSync(join(repo, "large.txt"), "x".repeat(MAX_REVIEW_PATCH_CHARS + 1));

		await expect(collectReviewSnapshot(repo, {}, runGit)).rejects.toThrow(/too large|limit/);
	});
});

describe("prepareReviewArguments", () => {
	it("treats model-supplied null optionals as omitted", () => {
		expect(prepareReviewArguments({ base: null, paths: null })).toEqual({});
		expect(prepareReviewArguments({ base: "main", paths: ["src", null] })).toEqual({
			base: "main",
			paths: ["src"],
		});
	});
});
