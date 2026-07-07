import { describe, expect, it } from "vitest";
import { formatTaskPanelLines, type BgTaskSnapshot } from "./background.ts";

const startedAt = 1_000;
const now = 6_500;

function task(overrides: Partial<BgTaskSnapshot> = {}): BgTaskSnapshot {
	return {
		id: "abc12345",
		kind: "bash",
		label: "bun test",
		startedAt,
		finishedAt: null,
		exitCode: null,
		signal: null,
		timedOut: false,
		...overrides,
	};
}

describe("formatTaskPanelLines", () => {
	it("renders a fixed background task panel", () => {
		const lines = formatTaskPanelLines([task()], now);

		expect(lines[0]).toBe("Background Tasks");
		expect(lines[1]).toContain("running");
		expect(lines[1]).toContain("abc12345");
		expect(lines[1]).toContain("bash");
		expect(lines[1]).toContain("5.5s");
		expect(lines[1]).toContain("bun test");
	});

	it("summarizes completed tasks", () => {
		const lines = formatTaskPanelLines([task({ finishedAt: 3_000, exitCode: 0 })], now);

		expect(lines[1]).toContain("completed");
		expect(lines[1]).toContain("2.0s");
	});

	it("returns no lines when there are no tasks", () => {
		expect(formatTaskPanelLines([], now)).toEqual([]);
	});
});
