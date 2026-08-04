import { afterEach, describe, expect, it, vi } from "vitest";
import terminalStatusTitle from "./index.ts";

describe("terminal-status-title", () => {
	afterEach(() => vi.useRealTimers());

	it("updates status and session names, then cleans up its timers", () => {
		vi.useFakeTimers();
		const handlers: Record<string, Function> = {};
		let sessionName: string | undefined;
		const setTitle = vi.fn();
		terminalStatusTitle({
			on(event: string, handler: Function) { handlers[event] = handler; },
			getSessionName: () => sessionName,
		} as any);
		const ctx = { hasUI: true, cwd: "/work/pi-oh-my", ui: { setTitle } };

		handlers.session_start!({}, ctx);
		expect(setTitle).toHaveBeenLastCalledWith("○ | π | pi-oh-my");
		vi.advanceTimersByTime(0);

		handlers.agent_start!({}, ctx);
		expect(setTitle).toHaveBeenLastCalledWith("⠋ | π | pi-oh-my");
		vi.advanceTimersByTime(120);
		expect(setTitle).toHaveBeenLastCalledWith("⠙ | π | pi-oh-my");

		sessionName = "renamed session";
		handlers.session_info_changed!({}, ctx);
		vi.advanceTimersByTime(0);
		expect(setTitle).toHaveBeenLastCalledWith("⠙ | π | renamed session");

		handlers.agent_settled!({}, ctx);
		expect(setTitle).toHaveBeenLastCalledWith("✓ | π | renamed session");
		handlers.session_shutdown!({}, ctx);
		expect(vi.getTimerCount()).toBe(0);
	});
});
