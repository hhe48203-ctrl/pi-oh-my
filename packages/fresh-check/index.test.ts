import { describe, expect, it } from "vitest";
import freshCheck, { createFreshCheckState, isVerificationCommand, observeToolResult, reconstructFreshCheckState } from "./index.ts";

describe("fresh-check", () => {
	it("recognizes checks without treating installs as verification", () => {
		expect(isVerificationCommand("bun test")).toBe(true);
		expect(isVerificationCommand("npm run lint && tsc --noEmit")).toBe(true);
		expect(isVerificationCommand("bun run test:offline")).toBe(true);
		expect(isVerificationCommand("bun run src/test-roles.ts && bun run src/test-bridge-gateway.ts")).toBe(true);
		expect(isVerificationCommand("bun run src/config.test.ts")).toBe(true);
		expect(isVerificationCommand("bun install")).toBe(false);
		expect(isVerificationCommand("bun run src/build-fixtures.ts")).toBe(false);
	});

	it("requires a successful check after the latest change", () => {
		const changed = observeToolResult(createFreshCheckState(), {
			toolName: "hashline_edit",
			input: { path: "src/a.ts" },
			isError: false,
		});
		expect(changed.changedFiles).toEqual(["src/a.ts"]);

		const checked = observeToolResult(changed, {
			toolName: "bash",
			input: { command: "bun test" },
			isError: false,
		});
		expect(checked.changedFiles).toEqual([]);
		expect(checked.lastCheck).toBe("bun test");
	});

	it("does not let an older background check verify a newer edit", () => {
		const changed = observeToolResult(createFreshCheckState(), {
			toolName: "write",
			input: { path: "src/a.ts" },
			isError: false,
		});
		const started = observeToolResult(changed, {
			toolName: "bash_bg",
			input: { command: "bun test" },
			details: { taskId: "task-1" },
			isError: false,
		});
		const changedAgain = observeToolResult(started, {
			toolName: "edit",
			input: { path: "src/b.ts" },
			isError: false,
		});
		const completed = observeToolResult(changedAgain, {
			toolName: "check_bg",
			input: { task_id: "task-1" },
			text: "Status: completed",
			isError: false,
		});
		expect(completed.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
		expect(completed.pending).toEqual({});
	});

	it("conservatively tracks a failed writable subagent", () => {
		const state = observeToolResult(createFreshCheckState(), {
			toolName: "subagent",
			input: { description: "attempt fix", tools: "read,bash,edit" },
			isError: true,
		});
		expect(state.changedFiles).toEqual(["subagent: attempt fix"]);
	});

	it("restores the newest durable state", () => {
		const restored = reconstructFreshCheckState([
			{ type: "custom", customType: "fresh-check-state", data: { revision: 1, changedFiles: ["old.ts"], pending: {} } },
			{ type: "custom", customType: "fresh-check-state", data: { revision: 2, changedFiles: ["new.ts"], pending: {} } },
		] as any);
		expect(restored.changedFiles).toEqual(["new.ts"]);
	});

	it("blocks Goal completion until a later check succeeds", () => {
		const handlers: Record<string, Function> = {};
		freshCheck({
			on(event: string, handler: Function) { handlers[event] = handler; },
			registerCommand() {},
			appendEntry() {},
		} as any);
		const ctx = {
			sessionManager: { getBranch: () => [] },
			ui: { setStatus() {} },
		};
		handlers.session_start!({}, ctx);
		handlers.tool_result!({
			toolName: "write",
			input: { path: "src/a.ts" },
			details: undefined,
			content: [],
			isError: false,
		}, ctx);
		expect(handlers.tool_call!({ toolName: "update_goal", input: { status: "complete" } })).toMatchObject({ block: true });
	});
});
